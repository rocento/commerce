use super::App;
use domain_admin_operations::google::Config;
use infra_auth::{Error, Result};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use rust_decimal::{prelude::ToPrimitive, Decimal};
use serde_json::{json, Value};
use std::str::FromStr;
use uuid::Uuid;

pub fn signing_key(secret: &str) -> std::result::Result<(String, EncodingKey), &'static str> {
    let v: Value = serde_json::from_str(secret).map_err(|_| "invalid_credentials")?;
    let email = v["client_email"]
        .as_str()
        .filter(|s| s.ends_with(".iam.gserviceaccount.com"))
        .ok_or("invalid_credentials")?;
    let key = EncodingKey::from_rsa_pem(
        v["private_key"]
            .as_str()
            .ok_or("invalid_credentials")?
            .as_bytes(),
    )
    .map_err(|_| "invalid_credentials")?;
    Ok((email.into(), key))
}
async fn body(mut response: reqwest::Response) -> std::result::Result<Value, &'static str> {
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "access_denied",
            429 => "quota_exceeded",
            400 => "invalid_request",
            404 => "not_found",
            _ => "provider_unavailable",
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "provider_unavailable")? {
        if bytes.len() + chunk.len() > 262144 {
            return Err("invalid_response");
        }
        bytes.extend(chunk);
    }
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes).map_err(|_| "invalid_response")
}
async fn token(a: &App, secret: &str) -> std::result::Result<String, &'static str> {
    let (email, key) = signing_key(secret)?;
    let now = chrono::Utc::now().timestamp();
    let jwt=jsonwebtoken::encode(&Header::new(Algorithm::RS256),&json!({"iss":email,"scope":"https://www.googleapis.com/auth/content","aud":"https://oauth2.googleapis.com/token","iat":now,"exp":now+3600}),&key).map_err(|_|"invalid_credentials")?;
    let r = a
        .http
        .post("https://oauth2.googleapis.com/token")
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", &jwt),
        ])
        .send()
        .await
        .map_err(|_| "provider_unavailable")?;
    body(r).await?["access_token"]
        .as_str()
        .map(str::to_owned)
        .ok_or("invalid_response")
}
pub async fn test(a: &App, c: &Config, secret: &str) -> std::result::Result<(), &'static str> {
    let access = token(a, secret).await?;
    let r = a
        .http
        .get(format!(
            "https://merchantapi.googleapis.com/datasources/v1/accounts/{}/dataSources/{}",
            c.account_id, c.data_source_id
        ))
        .bearer_auth(access)
        .send()
        .await
        .map_err(|_| "provider_unavailable")?;
    let v = body(r).await?;
    if v["input"] != "API" || v.get("primaryProductDataSource").is_none() {
        return Err("primary_api_data_source_required");
    }
    Ok(())
}
fn product(
    s: &crate::public_commerce::snapshot::Snapshot,
    c: &Config,
    stock: i64,
) -> Option<Value> {
    let p = s.product.as_ref()?;
    if s.status != 200 || s.robots != "index, follow" || !p.offer_eligible || s.locale != c.language
    {
        return None;
    }
    let image = s.images.get(&p.image_id?)?;
    let link = &s.canonical.as_ref()?.feed;
    let amount = (Decimal::from_str(&p.price).ok()? * Decimal::from(1_000_000)).to_i64()?;
    if amount <= 0 {
        return None;
    }
    let mut attributes = json!({"title":p.name,"description":p.description,"link":link,"imageLink":format!("{}api/v1/catalog/media/{}/content",s.origin,image.id),"availability":if stock>0{"IN_STOCK"}else{"OUT_OF_STOCK"},"price":{"amountMicros":amount.to_string(),"currencyCode":p.currency}});
    identifiers(&mut attributes, &p.attributes);
    Some(
        json!({"offerId":p.id.to_string(),"contentLanguage":c.language,"feedLabel":c.feed_label,"productAttributes":attributes}),
    )
}
fn identifiers(attributes: &mut Value, source: &Value) {
    for field in ["brand", "mpn", "condition"] {
        if let Some(v) = source
            .get(field)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            attributes[field] = json!(if field == "condition" {
                v.to_uppercase()
            } else {
                v.to_owned()
            });
        }
    }
    if let Some(gtin) = source["gtin"].as_str().filter(|s| !s.is_empty()) {
        attributes["gtins"] = json!([gtin]);
    }
}
// One durable keyset item per step. The row lock serializes saves/disconnects with
// sends, and the advisory lock prevents two replicas sending stale versions.
pub async fn step(a: &App) -> Result<()> {
    if a.service.vault.is_none() {
        return Ok(());
    }
    let mut tx = a.service.pool.begin().await?;
    let locked: bool = sqlx::query_scalar("SELECT pg_try_advisory_xact_lock(902120)")
        .fetch_one(&mut *tx)
        .await?;
    if !locked {
        return Ok(());
    }
    let row:Option<(Value,Vec<u8>,Uuid)>=sqlx::query_as("SELECT config,credentials,sync_cursor FROM platform.google_connections WHERE service='merchant' AND enabled AND credentials IS NOT NULL AND next_sync_at<=now() FOR UPDATE").fetch_optional(&mut *tx).await?;
    let Some((config, encrypted, cursor)) = row else {
        return Ok(());
    };
    if cursor.is_nil() {
        sqlx::query("UPDATE platform.google_connections SET sync_scanned=0,sync_submitted=0,sync_excluded=0,sync_rejected=0 WHERE service='merchant'").execute(&mut *tx).await?;
    }
    let c: Config = serde_json::from_value(config).map_err(|_| Error::Internal)?;
    let candidate:Option<(Uuid,Option<String>)>=sqlx::query_as("SELECT ids.id,p.slug FROM (SELECT id FROM catalog.storefront_products UNION SELECT product_id FROM platform.google_products) ids LEFT JOIN catalog.storefront_products p ON p.id=ids.id WHERE ids.id>$1 ORDER BY ids.id LIMIT 1").bind(cursor).fetch_optional(&mut *tx).await?;
    let Some((id, slug)) = candidate else {
        sqlx::query("UPDATE platform.google_connections SET sync_cursor='00000000-0000-0000-0000-000000000000',next_sync_at=now()+interval '1 hour',last_sync_at=now(),sync_code=CASE WHEN sync_rejected>0 THEN 'completed_with_rejections' ELSE 'completed' END WHERE service='merchant'").execute(&mut *tx).await?;
        tx.commit().await?;
        return Ok(());
    };
    let payload = if let Some(slug) = slug {
        let snapshot = crate::public_commerce::snapshot::assemble(
            &a.publication,
            crate::public_commerce::snapshot::Request {
                path: format!("/products/{slug}"),
                page: 1,
            },
            None,
        )
        .await?;
        let stocks = a
            .identity
            .cart
            .inventory
            .browsing_stocks(None, true)
            .await?;
        let availability = a
            .identity
            .cart
            .inventory
            .browsing_available_many(&[id], &stocks, None)
            .await?;
        product(&snapshot, &c, *availability.get(&id).unwrap_or(&0))
    } else {
        None
    };
    let submitted: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM platform.google_products WHERE product_id=$1)",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    let result = if payload.is_none() && !submitted {
        Ok(())
    } else {
        match a.service.decode("merchant", &encrypted).await {
            Err(_) => Err("credential_unavailable"),
            Ok(secret) => match token(a, &secret).await {
                Err(code) => Err(code),
                Ok(access) => {
                    let source =
                        format!("accounts/{}/dataSources/{}", c.account_id, c.data_source_id);
                    let request = if let Some(ref value) = payload {
                        a.http.post(format!("https://merchantapi.googleapis.com/products/v1/accounts/{}/productInputs:insert",c.account_id)).json(value)
                    } else {
                        a.http.delete(format!("https://merchantapi.googleapis.com/products/v1/accounts/{}/productInputs/{}~{}~{}",c.account_id,c.language,c.feed_label,id))
                    };
                    match request
                        .bearer_auth(access)
                        .query(&[("dataSource", source)])
                        .send()
                        .await
                    {
                        Ok(r) if payload.is_none() && r.status().as_u16() == 404 => Ok(()),
                        Ok(r) => body(r).await.map(|_| ()),
                        Err(_) => Err("provider_unavailable"),
                    }
                }
            },
        }
    };
    match result {
        Ok(()) => {
            if payload.is_some() {
                sqlx::query("INSERT INTO platform.google_products(product_id) VALUES($1) ON CONFLICT(product_id) DO UPDATE SET submitted_at=now()").bind(id).execute(&mut *tx).await?;
            } else {
                sqlx::query("DELETE FROM platform.google_products WHERE product_id=$1")
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
            sqlx::query("UPDATE platform.google_connections SET sync_cursor=$1,sync_code='running',sync_scanned=sync_scanned+1,sync_submitted=sync_submitted+$2,sync_excluded=sync_excluded+$3 WHERE service='merchant'").bind(id).bind(if payload.is_some(){1i64}else{0}).bind(if payload.is_none(){1i64}else{0}).execute(&mut *tx).await?;
        }
        Err("invalid_request") => {
            sqlx::query("UPDATE platform.google_connections SET sync_cursor=$1,sync_scanned=sync_scanned+1,sync_rejected=sync_rejected+1,sync_code='product_rejected' WHERE service='merchant'").bind(id).execute(&mut *tx).await?;
        }
        Err(code) => {
            sqlx::query("UPDATE platform.google_connections SET sync_code=$1,next_sync_at=now()+interval '5 minutes' WHERE service='merchant'").bind(code).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn v1_identifiers_use_repeated_gtins_and_enum_condition() {
        let mut attributes = json!({});
        identifiers(
            &mut attributes,
            &json!({"brand":"Shop","gtin":"1234567890123","mpn":"A1","condition":"new","private_supplier_cost":"secret"}),
        );
        assert_eq!(
            attributes,
            json!({"brand":"Shop","gtins":["1234567890123"],"mpn":"A1","condition":"NEW"})
        );
    }
    #[test]
    fn credential_parser_never_echoes_private_input() {
        assert_eq!(
            signing_key("secret-canary").err(),
            Some("invalid_credentials")
        );
    }
}
