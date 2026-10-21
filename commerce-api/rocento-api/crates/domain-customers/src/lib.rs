pub mod deletion;
pub mod memory;
pub mod segments;
use chrono::{DateTime, Utc};
use infra_auth::{Error, Result, Security};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
    pub security: Security,
}
#[derive(Serialize, FromRow)]
pub struct Customer {
    pub entity_id: i64,
    pub id: Uuid,
    pub email: Option<String>,
    pub mobile_number: Option<String>,
    pub primary_identifier: String,
    pub verified: bool,
    pub created_at: DateTime<Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Credentials {
    pub identifier: String,
    pub password: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChallengeRequest {
    pub identifier: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Verify {
    pub identifier: String,
    pub token: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reset {
    pub identifier: String,
    pub token: String,
    pub password: String,
}
#[derive(Serialize)]
pub struct Auth {
    pub customer: Customer,
    pub access_token: String,
}
pub struct Login {
    pub body: Auth,
    pub refresh: String,
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct LocationGeography {
    pub country_code: String,
    pub state_code: String,
    pub state_name: String,
    pub city_id: String,
    pub city_name: String,
}
fn default_location_method() -> String {
    "pin".into()
}
#[derive(Serialize, Deserialize, Clone)]
#[serde(deny_unknown_fields)]
pub struct LocationInput {
    #[serde(default = "default_location_method")]
    pub location_method: String,
    #[serde(default)]
    pub geography: Option<sqlx::types::Json<LocationGeography>>,
    pub label: String,
    #[serde(default)]
    pub custom_label: String,
    pub latitude: f64,
    pub longitude: f64,
    pub formatted_address: String,
    #[serde(default)]
    pub building: String,
    #[serde(default)]
    pub floor: String,
    #[serde(default)]
    pub apartment: String,
    #[serde(default)]
    pub delivery_instructions: String,
    #[serde(default)]
    pub is_default: bool,
}
#[derive(Serialize, FromRow)]
pub struct Location {
    pub entity_id: i64,
    pub location_method: String,
    pub geography: Option<sqlx::types::Json<LocationGeography>>,
    pub id: Uuid,
    pub label: String,
    pub custom_label: String,
    pub latitude: f64,
    pub longitude: f64,
    pub formatted_address: String,
    pub building: String,
    pub floor: String,
    pub apartment: String,
    pub delivery_instructions: String,
    pub is_default: bool,
    pub area_id: Option<Uuid>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
impl LocationInput {
    pub fn validate(&self) -> Result<()> {
        if !["pin", "neighborhood"].contains(&self.location_method.as_str()) {
            return Err(Error::Invalid("Choose neighborhood or pin".into()));
        }
        if self.location_method == "neighborhood" {
            let geography = self
                .geography
                .as_ref()
                .ok_or_else(|| Error::Invalid("Choose country, state and city".into()))?;
            if geography.country_code.len() != 2
                || !geography
                    .country_code
                    .bytes()
                    .all(|c| c.is_ascii_uppercase())
            {
                return Err(Error::Invalid("Invalid country code".into()));
            }
            for value in [
                &geography.state_code,
                &geography.state_name,
                &geography.city_id,
                &geography.city_name,
            ] {
                if value.trim().is_empty() || value.len() > 200 {
                    return Err(Error::Invalid("Choose country, state and city".into()));
                }
            }
        } else if self.geography.is_some() {
            return Err(Error::Invalid(
                "A pin cannot also select a neighborhood".into(),
            ));
        }
        if !["home", "work", "other"].contains(&self.label.as_str()) {
            return Err(Error::Invalid("Choose home, work, or other".into()));
        }
        if !self.latitude.is_finite()
            || !self.longitude.is_finite()
            || !(-90.0..=90.0).contains(&self.latitude)
            || !(-180.0..=180.0).contains(&self.longitude)
        {
            return Err(Error::Invalid(
                "Coordinates are outside the valid range".into(),
            ));
        }
        for (value, name, max, required) in [
            (
                &self.custom_label,
                "Custom label",
                60,
                self.label == "other",
            ),
            (&self.formatted_address, "Address", 500, true),
            (&self.building, "Building", 120, false),
            (&self.floor, "Floor", 40, false),
            (&self.apartment, "Apartment", 40, false),
            (&self.delivery_instructions, "Instructions", 1000, false),
        ] {
            infra_auth::bounded(value, name, max, required)?;
        }
        Ok(())
    }
}
impl Service {
    async fn find(&self, identifier: &str) -> Result<Option<Uuid>> {
        Ok(sqlx::query_scalar(
            "SELECT id FROM customers.customers WHERE email=$1 OR mobile_number=$1",
        )
        .bind(identifier)
        .fetch_optional(&self.pool)
        .await?)
    }
    pub async fn customer(&self, id: Uuid) -> Result<Customer> {
        sqlx::query_as("SELECT id,entity_id,email,mobile_number,primary_identifier,verified,created_at FROM customers.customers WHERE id=$1 AND deletion_requested_at IS NULL").bind(id).fetch_optional(&self.pool).await?.ok_or(Error::Unauthorized)
    }
    async fn lock(tx: &mut sqlx::Transaction<'_, sqlx::Postgres>, id: Uuid) -> Result<()> {
        sqlx::query("SELECT id FROM customers.customers WHERE id=$1 AND deletion_requested_at IS NULL FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut **tx)
            .await?.ok_or(Error::Unauthorized)?;
        Ok(())
    }
    /// Re-authorize a short-lived delegated session without sharing the access-token key.
    pub async fn authorize_session(&self, customer: Uuid, session: Uuid) -> Result<()> {
        let valid: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers.sessions WHERE id=$1 AND customer_id=$2 AND expires_at>now())")
            .bind(session).bind(customer).fetch_one(&self.pool).await?;
        if !valid {
            return Err(Error::Unauthorized);
        }
        Ok(())
    }
    pub async fn authenticate(&self, token: &str) -> Result<Customer> {
        let c = self.security.decode(token)?;
        let valid:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers.sessions WHERE id=$1 AND customer_id=$2 AND expires_at>now())").bind(c.sid).bind(c.sub).fetch_one(&self.pool).await?;
        if !valid {
            return Err(Error::Unauthorized);
        }
        self.customer(c.sub).await
    }
    /// Reusable server-side gate for checkout in M4; never trust JWT verification claims.
    pub async fn require_verified(&self, token: &str) -> Result<Customer> {
        let c = self.authenticate(token).await?;
        if !c.verified {
            return Err(Error::Forbidden);
        }
        Ok(c)
    }
    async fn challenge(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        id: Uuid,
        purpose: &str,
        code: &str,
    ) -> Result<()> {
        sqlx::query("INSERT INTO customers.challenges(customer_id,purpose,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '15 minutes') ON CONFLICT(customer_id,purpose) DO UPDATE SET token_hash=EXCLUDED.token_hash,expires_at=EXCLUDED.expires_at").bind(id).bind(purpose).bind(self.security.challenge_hash(id,purpose,code)).execute(&mut **tx).await?;
        if self.security.queued_notifications {
            let (identifier, kind): (String, String) = sqlx::query_as("SELECT CASE WHEN primary_identifier='mobile' THEN mobile_number ELSE email END,primary_identifier FROM customers.customers WHERE id=$1")
                .bind(id).fetch_one(&mut **tx).await?;
            let notification =
                self.security
                    .notification(&identifier, purpose, code, kind == "mobile");
            infra_auth::notifications::enqueue(
                tx,
                Uuid::new_v4(),
                Some(id),
                Some(self.security.challenge_hash(id, purpose, code)),
                &notification,
                900,
            )
            .await?;
        }
        Ok(())
    }
    pub async fn register(&self, input: Credentials) -> Result<Customer> {
        let (identifier, kind) = infra_auth::identifier(&input.identifier)?;
        if self.security.email_notifications_only && kind == "mobile" {
            return Err(Error::Invalid(
                "Use an email address; SMS delivery is not configured".into(),
            ));
        }
        infra_auth::rate_limit(&self.pool, &format!("register:{identifier}"), 5).await?;
        let password = infra_auth::hash_password(input.password).await?;
        let id = Uuid::new_v4();
        let code = if kind == "mobile" {
            infra_auth::otp()
        } else {
            infra_auth::token()
        };
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO customers.customers(id,email,mobile_number,primary_identifier,password_hash) VALUES($1,$2,$3,$4,$5)").bind(id).bind(if kind=="email"{Some(&identifier)}else{None}).bind(if kind=="mobile"{Some(&identifier)}else{None}).bind(kind).bind(password).execute(&mut *tx).await?;
        self.challenge(&mut tx, id, "verify", &code).await?;
        infra_events::record(
            &mut tx,
            "customer.registered",
            serde_json::json!({"customer_id":id}),
        )
        .await?;
        tx.commit().await?;
        self.security
            .deliver(&identifier, "verify", &code, kind == "mobile");
        self.customer(id).await
    }
    pub async fn login(&self, input: Credentials) -> Result<Login> {
        let (identifier, _) = infra_auth::identifier(&input.identifier)?;
        infra_auth::rate_limit(&self.pool, &format!("login:{identifier}"), 10).await?;
        let row: Option<(Uuid, String)> = sqlx::query_as(
            "SELECT id,password_hash FROM customers.customers WHERE email=$1 OR mobile_number=$1",
        )
        .bind(identifier)
        .fetch_optional(&self.pool)
        .await?;
        let hash = row
            .as_ref()
            .map(|r| r.1.clone())
            .unwrap_or_else(|| self.security.dummy_hash.clone());
        if !infra_auth::verify_password(input.password, hash.clone()).await? {
            return Err(Error::Unauthorized);
        }
        let (id, _) = row.ok_or(Error::Unauthorized)?;
        let mut tx = self.pool.begin().await?;
        Self::lock(&mut tx, id).await?;
        let current: String =
            sqlx::query_scalar("SELECT password_hash FROM customers.customers WHERE id=$1")
                .bind(id)
                .fetch_one(&mut *tx)
                .await?;
        if current != hash {
            return Err(Error::Unauthorized);
        }
        let sid = Uuid::new_v4();
        let refresh = infra_auth::token();
        sqlx::query("INSERT INTO customers.sessions(id,customer_id,refresh_hash,expires_at) VALUES($1,$2,$3,now()+interval '30 days')").bind(sid).bind(id).bind(infra_auth::digest(&refresh)).execute(&mut *tx).await?;
        infra_events::record(
            &mut tx,
            "customer.logged_in",
            serde_json::json!({"customer_id":id}),
        )
        .await?;
        tx.commit().await?;
        Ok(Login {
            body: Auth {
                customer: self.customer(id).await?,
                access_token: self.security.access_token(id, sid)?,
            },
            refresh,
        })
    }
    pub async fn refresh(&self, value: &str) -> Result<Login> {
        let hash = infra_auth::digest(value);
        let owner: Uuid = sqlx::query_scalar(
            "SELECT customer_id FROM customers.sessions WHERE refresh_hash=$1 AND expires_at>now()",
        )
        .bind(&hash)
        .fetch_optional(&self.pool)
        .await?
        .ok_or(Error::Unauthorized)?;
        let mut tx = self.pool.begin().await?;
        Self::lock(&mut tx, owner).await?;
        // The customer lock may have waited past expiry. PostgreSQL now() is
        // fixed at transaction start, so authorization must use the live clock.
        let sid:Uuid=sqlx::query_scalar("SELECT id FROM customers.sessions WHERE refresh_hash=$1 AND expires_at>clock_timestamp() FOR UPDATE").bind(&hash).fetch_optional(&mut *tx).await?.ok_or(Error::Unauthorized)?;
        let refresh = infra_auth::token();
        sqlx::query("UPDATE customers.sessions SET refresh_hash=$1 WHERE id=$2")
            .bind(infra_auth::digest(&refresh))
            .bind(sid)
            .execute(&mut *tx)
            .await?;
        infra_events::record(
            &mut tx,
            "customer.session_refreshed",
            serde_json::json!({"customer_id":owner}),
        )
        .await?;
        tx.commit().await?;
        Ok(Login {
            body: Auth {
                customer: self.customer(owner).await?,
                access_token: self.security.access_token(owner, sid)?,
            },
            refresh,
        })
    }
    pub async fn logout(&self, value: &str, access: Option<&str>) -> Result<()> {
        let claims = access.and_then(|token| self.security.decode(token).ok());
        let mut tx = self.pool.begin().await?;
        let owner: Option<Uuid> = sqlx::query_scalar(
            "DELETE FROM customers.sessions WHERE refresh_hash=$1 OR (id=$2 AND customer_id=$3) RETURNING customer_id",
        )
        .bind(infra_auth::digest(value))
        .bind(claims.as_ref().map(|c|c.sid))
        .bind(claims.as_ref().map(|c|c.sub))
        .fetch_optional(&mut *tx)
        .await?;
        if let Some(id) = owner {
            infra_events::record(
                &mut tx,
                "customer.logged_out",
                serde_json::json!({"customer_id":id}),
            )
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }
    pub async fn request_challenge(&self, input: ChallengeRequest, purpose: &str) -> Result<()> {
        let (identifier, kind) = infra_auth::identifier(&input.identifier)?;
        if self.security.email_notifications_only && kind == "mobile" {
            return Err(Error::Invalid(
                "Use an email address; SMS delivery is not configured".into(),
            ));
        }
        infra_auth::rate_limit(&self.pool, &format!("send:{identifier}"), 5).await?;
        if let Some(id) = self.find(&identifier).await? {
            let mut tx = self.pool.begin().await?;
            Self::lock(&mut tx, id).await?;
            let verified: bool =
                sqlx::query_scalar("SELECT verified FROM customers.customers WHERE id=$1")
                    .bind(id)
                    .fetch_one(&mut *tx)
                    .await?;
            if purpose == "verify" && verified {
                return Ok(());
            }
            let code = if kind == "mobile" {
                infra_auth::otp()
            } else {
                infra_auth::token()
            };
            self.challenge(&mut tx, id, purpose, &code).await?;
            infra_events::record(
                &mut tx,
                "customer.challenge_requested",
                serde_json::json!({"customer_id":id,"purpose":purpose}),
            )
            .await?;
            tx.commit().await?;
            self.security
                .deliver(&identifier, purpose, &code, kind == "mobile");
        }
        Ok(())
    }
    pub async fn verify(&self, input: Verify) -> Result<()> {
        self.consume(input.identifier, input.token, None).await
    }
    pub async fn reset(&self, input: Reset) -> Result<()> {
        self.consume(input.identifier, input.token, Some(input.password))
            .await
    }
    async fn consume(
        &self,
        identifier: String,
        code: String,
        password: Option<String>,
    ) -> Result<()> {
        let (identifier, _) = infra_auth::identifier(&identifier)?;
        infra_auth::bounded(&code, "Verification code", 128, true)?;
        infra_auth::rate_limit(&self.pool, &format!("challenge:{identifier}"), 10).await?;
        let purpose = if password.is_some() {
            "reset"
        } else {
            "verify"
        };
        let hash = if let Some(p) = password {
            Some(infra_auth::hash_password(p).await?)
        } else {
            None
        };
        let id = self.find(&identifier).await?.ok_or(Error::Unauthorized)?;
        let mut tx = self.pool.begin().await?;
        Self::lock(&mut tx, id).await?;
        // A request blocked on the customer row must not consume a challenge
        // which expired after the transaction began.
        let removed=sqlx::query("DELETE FROM customers.challenges WHERE customer_id=$1 AND purpose=$2 AND token_hash=$3 AND expires_at>clock_timestamp()").bind(id).bind(purpose).bind(self.security.challenge_hash(id,purpose,&code)).execute(&mut *tx).await?.rows_affected();
        if removed != 1 {
            return Err(Error::Unauthorized);
        }
        if let Some(hash) = hash {
            sqlx::query("UPDATE customers.customers SET password_hash=$1 WHERE id=$2")
                .bind(hash)
                .bind(id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("DELETE FROM customers.sessions WHERE customer_id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        } else {
            sqlx::query("UPDATE customers.customers SET verified=true WHERE id=$1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        infra_events::record(
            &mut tx,
            if purpose == "reset" {
                "customer.password_reset"
            } else {
                "customer.verified"
            },
            serde_json::json!({"customer_id":id}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn locations(&self, owner: Uuid) -> Result<Vec<Location>> {
        Ok(sqlx::query_as("SELECT * FROM customers.customer_locations WHERE customer_id=$1 ORDER BY is_default DESC,created_at,id").bind(owner).fetch_all(&self.pool).await?)
    }
    pub async fn save_location(
        &self,
        owner: Uuid,
        id: Option<Uuid>,
        input: LocationInput,
    ) -> Result<Location> {
        input.validate()?;
        let mut tx = self.pool.begin().await?;
        Self::lock(&mut tx, owner).await?;
        let existing = if let Some(id) = id {
            Some(sqlx::query_scalar::<_,bool>("SELECT is_default FROM customers.customer_locations WHERE id=$1 AND customer_id=$2").bind(id).bind(owner).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?)
        } else {
            None
        };
        let count: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM customers.customer_locations WHERE customer_id=$1",
        )
        .bind(owner)
        .fetch_one(&mut *tx)
        .await?;
        if id.is_none() && count >= 50 {
            return Err(Error::Invalid("You can save up to 50 locations".into()));
        }
        let default = input.is_default || count == 0 || existing == Some(true);
        if default {
            sqlx::query(
                "UPDATE customers.customer_locations SET is_default=false WHERE customer_id=$1",
            )
            .bind(owner)
            .execute(&mut *tx)
            .await?;
        }
        let location_id = id.unwrap_or_else(Uuid::new_v4);
        let location=sqlx::query_as("INSERT INTO customers.customer_locations(id,customer_id,label,custom_label,latitude,longitude,formatted_address,building,floor,apartment,delivery_instructions,is_default,location_method,geography) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO UPDATE SET label=EXCLUDED.label,custom_label=EXCLUDED.custom_label,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,formatted_address=EXCLUDED.formatted_address,building=EXCLUDED.building,floor=EXCLUDED.floor,apartment=EXCLUDED.apartment,delivery_instructions=EXCLUDED.delivery_instructions,is_default=EXCLUDED.is_default,location_method=EXCLUDED.location_method,geography=EXCLUDED.geography,updated_at=now() RETURNING *")
   .bind(location_id).bind(owner).bind(input.label).bind(input.custom_label).bind(input.latitude).bind(input.longitude).bind(input.formatted_address).bind(input.building).bind(input.floor).bind(input.apartment).bind(input.delivery_instructions).bind(default).bind(input.location_method).bind(input.geography).fetch_one(&mut *tx).await?;
        infra_events::record(
            &mut tx,
            if id.is_some() {
                "customer.location_updated"
            } else {
                "customer.location_created"
            },
            serde_json::json!({"customer_id":owner,"location_id":location_id}),
        )
        .await?;
        tx.commit().await?;
        Ok(location)
    }
    pub async fn delete_location(&self, owner: Uuid, id: Uuid) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        Self::lock(&mut tx, owner).await?;
        let default:bool=sqlx::query_scalar("DELETE FROM customers.customer_locations WHERE id=$1 AND customer_id=$2 RETURNING is_default").bind(id).bind(owner).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
        if default {
            sqlx::query("UPDATE customers.customer_locations SET is_default=true,updated_at=now() WHERE id=(SELECT id FROM customers.customer_locations WHERE customer_id=$1 ORDER BY created_at,id LIMIT 1)").bind(owner).execute(&mut *tx).await?;
        }
        infra_events::record(
            &mut tx,
            "customer.location_deleted",
            serde_json::json!({"customer_id":owner,"location_id":id}),
        )
        .await?;
        tx.commit().await?;
        Ok(())
    }
}

impl Service {
    /// Resolve an owned delivery snapshot and recheck verification inside order placement.
    pub async fn checkout_location(
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        owner: Uuid,
        location: Uuid,
    ) -> Result<(Customer, Location)> {
        let c: Customer=sqlx::query_as("SELECT id,entity_id,email,mobile_number,primary_identifier,verified,created_at FROM customers.customers WHERE id=$1 AND deletion_requested_at IS NULL FOR SHARE").bind(owner).fetch_optional(&mut **tx).await?.ok_or(Error::Unauthorized)?;
        if !c.verified {
            return Err(Error::Forbidden);
        }
        let l = sqlx::query_as(
            "SELECT * FROM customers.customer_locations WHERE id=$1 AND customer_id=$2 FOR SHARE",
        )
        .bind(location)
        .bind(owner)
        .fetch_optional(&mut **tx)
        .await?
        .ok_or(Error::NotFound)?;
        Ok((c, l))
    }
}

#[derive(Serialize, Deserialize, FromRow)]
pub struct Profile {
    pub first_name: String,
    pub last_name: String,
    pub date_of_birth: Option<chrono::NaiveDate>,
    pub gender: String,
    pub customer_group: String,
    pub company_id: Option<Uuid>,
    pub negotiated_price_list_id: Option<Uuid>,
    pub attributes: serde_json::Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProfileInput {
    pub first_name: String,
    pub last_name: String,
    pub date_of_birth: Option<chrono::NaiveDate>,
    pub gender: String,
    pub attributes: serde_json::Value,
}
impl Service {
    pub async fn profile(&self, id: Uuid) -> Result<Profile> {
        sqlx::query_as("SELECT first_name,last_name,date_of_birth,gender,customer_group,company_id,negotiated_price_list_id,attributes FROM customers.customers WHERE id=$1").bind(id).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)
    }
    pub async fn save_profile(&self, id: Uuid, i: ProfileInput) -> Result<Profile> {
        if i.first_name.len() > 120
            || i.last_name.len() > 120
            || !["", "female", "male", "other", "prefer_not_to_say"].contains(&i.gender.as_str())
            || i.date_of_birth.is_some_and(|d| {
                d > Utc::now().date_naive()
                    || d < chrono::NaiveDate::from_ymd_opt(1900, 1, 1).unwrap()
            })
        {
            return Err(Error::Invalid(
                "Invalid name, gender or date of birth".into(),
            ));
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(2002)")
            .execute(&mut *tx)
            .await?;
        Self::lock(&mut tx, id).await?;
        domain_attributes::validate(&mut tx, "customer", id, &i.attributes, false).await?;
        sqlx::query("UPDATE customers.customers SET first_name=$2,last_name=$3,date_of_birth=$4,gender=$5,attributes=$6 WHERE id=$1").bind(id).bind(i.first_name.trim()).bind(i.last_name.trim()).bind(i.date_of_birth).bind(i.gender).bind(i.attributes).execute(&mut *tx).await?;
        tx.commit().await?;
        self.profile(id).await
    }
}
