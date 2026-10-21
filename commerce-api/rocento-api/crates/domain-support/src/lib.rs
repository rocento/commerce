//! Rust owns support state, authorization, deduplication, audit and transactional events.
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
    pub tenant: Uuid,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TicketInput {
    pub request_id: Uuid,
    pub subject: String,
    pub category: String,
    pub body: String,
    pub order_id: Option<Uuid>,
    pub contact_name: Option<String>,
    pub contact: Option<String>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reply {
    pub request_id: Uuid,
    pub body: String,
    pub status: Option<String>,
}
#[derive(Serialize, FromRow)]
pub struct Ticket {
    pub entity_id: i64,
    pub id: Uuid,
    pub number: i64,
    pub subject: String,
    pub category: String,
    pub status: String,
    pub priority: String,
    pub order_id: Option<Uuid>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Serialize, FromRow)]
pub struct Message {
    pub entity_id: i64,
    pub id: Uuid,
    pub sender: String,
    pub body: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Serialize)]
pub struct Detail {
    pub ticket: Ticket,
    pub messages: Vec<Message>,
    pub contact_name: Option<String>,
    pub contact: Option<String>,
}
pub enum Actor<'a> {
    Customer(Uuid),
    Guest(&'a str),
    Admin(&'a domain_admin_iam::Identity),
}
impl Actor<'_> {
    fn key(&self) -> String {
        match self {
            Self::Customer(id) => format!("customer:{id}"),
            Self::Guest(key) => format!("guest:{}", infra_auth::digest(key)),
            Self::Admin(who) => format!("admin:{}", who.user.id),
        }
    }
    fn customer(&self) -> Option<Uuid> {
        if let Self::Customer(id) = self {
            Some(*id)
        } else {
            None
        }
    }
    fn admin(&self, permission: &str) -> Result<bool> {
        if let Self::Admin(who) = self {
            who.require(permission)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }
}
impl Service {
    async fn read_in(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        id: Uuid,
        actor: &Actor<'_>,
    ) -> Result<Detail> {
        let admin = actor.admin("support.read")?;
        let ticket = sqlx::query_as("SELECT id,entity_id,number,subject,category,status,priority,order_id,created_at FROM support.tickets WHERE id=$1 AND tenant_id=$2 AND ($3 OR owner_key=$4)").bind(id).bind(self.tenant).bind(admin).bind(actor.key()).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?;
        let messages = sqlx::query_as("SELECT id,entity_id,sender,body,created_at FROM support.messages WHERE ticket_id=$1 AND tenant_id=$2 ORDER BY created_at,id LIMIT 100").bind(id).bind(self.tenant).fetch_all(&mut **tx).await?;
        let (contact_name, contact): (Option<String>, Option<String>) = if admin {
            sqlx::query_as(
                "SELECT contact_name,contact FROM support.tickets WHERE id=$1 AND tenant_id=$2",
            )
            .bind(id)
            .bind(self.tenant)
            .fetch_one(&mut **tx)
            .await?
        } else {
            (None, None)
        };
        Ok(Detail {
            ticket,
            messages,
            contact_name,
            contact,
        })
    }
    pub async fn detail(&self, id: Uuid, actor: &Actor<'_>) -> Result<Detail> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
            .execute(&mut *tx)
            .await?;
        let result = self.read_in(&mut tx, id, actor).await?;
        tx.commit().await?;
        Ok(result)
    }
    pub async fn list(&self, actor: &Actor<'_>) -> Result<Vec<Ticket>> {
        let admin = actor.admin("support.read")?;
        Ok(sqlx::query_as("SELECT id,entity_id,number,subject,category,status,priority,order_id,created_at FROM support.tickets WHERE tenant_id=$1 AND ($2 OR owner_key=$3) ORDER BY created_at DESC,id LIMIT 100").bind(self.tenant).bind(admin).bind(actor.key()).fetch_all(&self.pool).await?)
    }
    pub async fn create(&self, actor: &Actor<'_>, i: &TicketInput) -> Result<Detail> {
        if matches!(actor, Actor::Admin(_)) {
            return Err(Error::Forbidden);
        }
        infra_auth::bounded(&i.subject, "subject", 160, true)?;
        infra_auth::bounded(&i.body, "body", 2000, true)?;
        if ![
            "order_issue",
            "product_question",
            "complaint",
            "payment_dispute",
            "other",
        ]
        .contains(&i.category.as_str())
        {
            return Err(Error::Invalid("Invalid ticket category".into()));
        }
        if let Some(name) = &i.contact_name {
            infra_auth::bounded(name, "contact name", 100, true)?;
        }
        if let Some(contact) = &i.contact {
            infra_auth::identifier(contact)?;
        }
        if actor.customer().is_none() && (i.contact_name.is_none() || i.contact.is_none()) {
            return Err(Error::Invalid(
                "Guest contact name and email or mobile are required".into(),
            ));
        }
        if let Some(order) = i.order_id {
            let owner = actor.customer().ok_or(Error::Forbidden)?;
            domain_orders::Service {
                pool: self.pool.clone(),
            }
            .detail(order, Some(owner))
            .await?;
        }
        let key = actor.key();
        let hash = infra_auth::digest(&serde_json::to_string(i).map_err(|_| Error::Internal)?);
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
            .bind(format!("support:{}:{key}:{}", self.tenant, i.request_id))
            .execute(&mut *tx)
            .await?;
        let existing:Option<(Uuid,String)>=sqlx::query_as("SELECT id,request_hash FROM support.tickets WHERE tenant_id=$1 AND owner_key=$2 AND request_id=$3").bind(self.tenant).bind(&key).bind(i.request_id).fetch_optional(&mut *tx).await?;
        let id = if let Some((id, old_hash)) = existing {
            if hash != old_hash {
                return Err(Error::Conflict);
            }
            id
        } else {
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO support.tickets(id,tenant_id,owner_key,customer_id,request_id,request_hash,subject,category,priority,order_id,contact_name,contact) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)").bind(id).bind(self.tenant).bind(&key).bind(actor.customer()).bind(i.request_id).bind(&hash).bind(&i.subject).bind(&i.category).bind(if i.category=="payment_dispute" {"high"} else {"normal"}).bind(i.order_id).bind(&i.contact_name).bind(&i.contact).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO support.messages(id,tenant_id,ticket_id,request_id,actor_key,request_hash,sender,body) VALUES($1,$2,$3,$4,$5,$6,'customer',$7)").bind(Uuid::new_v4()).bind(self.tenant).bind(id).bind(i.request_id).bind(&key).bind(&hash).bind(&i.body).execute(&mut *tx).await?;
            self.audit(&mut tx, id, &key, "support.ticket_created")
                .await?;
            id
        };
        let result = self.read_in(&mut tx, id, actor).await?;
        tx.commit().await?;
        Ok(result)
    }
    async fn audit(
        &self,
        tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        id: Uuid,
        actor: &str,
        event: &str,
    ) -> Result<()> {
        sqlx::query("INSERT INTO support.audit(id,tenant_id,ticket_id,actor_key,action) VALUES($1,$2,$3,$4,$5)").bind(Uuid::new_v4()).bind(self.tenant).bind(id).bind(actor).bind(event).execute(&mut **tx).await?;
        infra_events::record(
            tx,
            event,
            serde_json::json!({"tenant_id":self.tenant,"ticket_id":id}),
        )
        .await?;
        Ok(())
    }
    pub async fn reply(&self, id: Uuid, actor: &Actor<'_>, i: &Reply) -> Result<Detail> {
        infra_auth::bounded(&i.body, "body", 2000, true)?;
        let admin = actor.admin("support.write")?;
        if i.status.is_some() && !admin {
            return Err(Error::Forbidden);
        }
        if i.status
            .as_ref()
            .is_some_and(|s| !["open", "in_progress", "resolved", "closed"].contains(&s.as_str()))
        {
            return Err(Error::Invalid("Invalid support status".into()));
        }
        let mut tx = self.pool.begin().await?;
        self.read_in(&mut tx, id, actor).await?;
        sqlx::query("SELECT id FROM support.tickets WHERE id=$1 AND tenant_id=$2 FOR UPDATE")
            .bind(id)
            .bind(self.tenant)
            .fetch_one(&mut *tx)
            .await?;
        let key = actor.key();
        let hash = infra_auth::digest(&serde_json::to_string(i).map_err(|_| Error::Internal)?);
        let existing:Option<String>=sqlx::query_scalar("SELECT request_hash FROM support.messages WHERE ticket_id=$1 AND tenant_id=$2 AND actor_key=$3 AND request_id=$4").bind(id).bind(self.tenant).bind(&key).bind(i.request_id).fetch_optional(&mut *tx).await?;
        if let Some(old) = existing {
            if old != hash {
                return Err(Error::Conflict);
            }
        } else {
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM support.messages WHERE ticket_id=$1 AND tenant_id=$2",
            )
            .bind(id)
            .bind(self.tenant)
            .fetch_one(&mut *tx)
            .await?;
            if count >= 100 {
                return Err(Error::Invalid("Ticket message limit reached".into()));
            }
            sqlx::query("INSERT INTO support.messages(id,tenant_id,ticket_id,request_id,actor_key,request_hash,sender,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8)").bind(Uuid::new_v4()).bind(self.tenant).bind(id).bind(i.request_id).bind(&key).bind(&hash).bind(if admin {"admin"} else {"customer"}).bind(&i.body).execute(&mut *tx).await?;
            if let Some(status) = &i.status {
                sqlx::query("UPDATE support.tickets SET status=$1,resolved_at=CASE WHEN $1 IN ('resolved','closed') THEN now() ELSE NULL END WHERE id=$2 AND tenant_id=$3").bind(status).bind(id).bind(self.tenant).execute(&mut *tx).await?;
            }
            self.audit(&mut tx, id, &key, "support.ticket_replied")
                .await?;
        }
        let result = self.read_in(&mut tx, id, actor).await?;
        tx.commit().await?;
        Ok(result)
    }
}
