//! Admin baseline diagnostics. Probes receive only a guest catalog-read capability.
use crate::{
    assistant,
    identity::{self, ApiError},
};
use axum::{
    extract::{rejection::JsonRejection, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use serde_json::json;
use uuid::Uuid;

#[derive(Clone)]
struct App {
    identity: identity::App,
    assistant: Option<assistant::App>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Input {
    query: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum CheckStatus {
    Pass,
    Fail,
    NotConfigured,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum CheckName {
    Provider,
    Assistant,
    CatalogTools,
    ToolSchemas,
    Knowledge,
    Storage,
    CommerceSchema,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Check {
    name: CheckName,
    status: CheckStatus,
    message: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum AcceptanceStatus {
    NotRun,
    NotConfigured,
    Pass,
    Fail,
    Stale,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Acceptance {
    status: AcceptanceStatus,
    checked_at: Option<chrono::DateTime<chrono::Utc>>,
    configuration_revision: Option<String>,
    request_reference: Option<Uuid>,
    message: String,
    duration_ms: Option<u64>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Readiness {
    version: String,
    tenant_id: Uuid,
    enabled: bool,
    provider_configured: bool,
    model: String,
    configuration_revision: String,
    tool_schema_revision: String,
    feature_flags: Vec<String>,
    checks: Vec<Check>,
    currency_modes: Vec<String>,
    quantity_modes: Vec<String>,
    payment_modes: Vec<String>,
    delivery_modes: Vec<String>,
    knowledge_configured: bool,
    last_acceptance: Acceptance,
}

pub fn router(identity: identity::App, assistant: Option<assistant::App>) -> Router {
    Router::new()
        .route("/v1/admin/assistant/readiness", get(readiness))
        .route("/v1/admin/assistant/acceptance", post(acceptance))
        .with_state(App {
            identity,
            assistant,
        })
}
fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":"Store diagnostics are unavailable. Check the assistant service, proxy configuration and acceptance storage."}))).into_response()
}

async fn forward(a: &App, headers: HeaderMap, input: Option<Input>) -> Result<Response, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&headers, "admin_session"))
        .await?;
    let testing = input.is_some();
    who.require(if testing {
        "assistant.settings.write"
    } else {
        "assistant.settings.read"
    })?;
    let Some(assistant) = &a.assistant else {
        return Ok(unavailable());
    };
    if let Some(body) = &input {
        infra_auth::bounded(&body.query, "query", 200, true)?;
        if body.query.trim().is_empty() {
            return Err(Error::Invalid("Enter a known catalog product".into()).into());
        }
        infra_auth::rate_limit(
            &a.identity.admins.pool,
            &format!("assistant-acceptance:{}", who.user.id),
            10,
        )
        .await?;
        let mut tx = a.identity.admins.pool.begin().await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "assistant.acceptance.requested",
            assistant.tenant,
            json!({}),
        )
        .await?;
        tx.commit().await?;
    }
    let now = chrono::Utc::now().timestamp();
    let mut claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "ai-service".into(),
        tenant: assistant.tenant,
        sub: None,
        sid: None,
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: if testing {
            "provider_settings_write"
        } else {
            "provider_settings_read"
        }
        .into(),
    };
    let auth = assistant.sign(&claims)?;
    claims.aud = "assistant-tools".into();
    claims.scope = "shopper_read".into();
    let catalog = assistant.sign(&claims)?;
    let request = if let Some(body) = input {
        assistant
            .client
            .post("http://assistant-ingress:8080/v1/provider-settings/acceptance")
            .json(&body)
    } else {
        assistant
            .client
            .get("http://assistant-ingress:8080/v1/provider-settings/readiness")
    };
    let mut response = match request
        .bearer_auth(auth)
        .header("x-commerce-catalog-token", catalog)
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response,
        Ok(response) if response.status().as_u16() == 429 => {
            return Ok((
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({"error":"Store acceptance is already running. Retry shortly."})),
            )
                .into_response())
        }
        _ => return Ok(unavailable()),
    };
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Internal)? {
        if bytes.len() + chunk.len() > 16384 {
            return Ok(unavailable());
        }
        bytes.extend(chunk);
    }
    // Explicit public types reject unrecognized/secret fields at the service boundary.
    let mut result = if testing {
        match serde_json::from_slice::<Acceptance>(&bytes) {
            Ok(value) if value.request_reference == Some(claims.request_id) => {
                Json(value).into_response()
            }
            _ => return Ok(unavailable()),
        }
    } else {
        match serde_json::from_slice::<Readiness>(&bytes) {
            Ok(mut value) if value.tenant_id == assistant.tenant && value.version == "1" => {
                let mut tx = a.identity.admins.pool.begin().await?;
                let market = domain_cart_checkout::market::configuration(&mut tx).await?;
                value.currency_modes = vec![market.currency];
                if market.enabled {
                    value.quantity_modes =
                        vec!["whole_selling_units".into(), "exact_measured_quanta".into()];
                }
                tx.commit().await?;
                let migrated: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM _sqlx_migrations WHERE version=20260921200000 AND success)")
                    .fetch_one(&a.identity.admins.pool).await?;
                value.checks.push(Check {
                    name: CheckName::CommerceSchema,
                    status: if migrated {
                        CheckStatus::Pass
                    } else {
                        CheckStatus::Fail
                    },
                    message: if migrated {
                        "Customer journey migration is applied."
                    } else {
                        "Customer journey migration is missing; deploy the matching commerce build."
                    }
                    .into(),
                });
                Json(value).into_response()
            }
            _ => return Ok(unavailable()),
        }
    };
    result
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    Ok(result)
}
async fn readiness(State(a): State<App>, headers: HeaderMap) -> Result<Response, ApiError> {
    forward(&a, headers, None).await
}
async fn acceptance(
    State(a): State<App>,
    headers: HeaderMap,
    input: Result<Json<Input>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(body) = input.map_err(|_| Error::Invalid("Enter a valid acceptance query".into()))?;
    forward(&a, headers, Some(body)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn acceptance_rejects_unknown_fields_and_statuses() {
        let value = json!({"status":"pass", "checked_at":null, "configuration_revision":null, "request_reference":null, "message":"ok", "duration_ms":1, "input_tokens":null, "output_tokens":null});
        assert!(serde_json::from_value::<Acceptance>(value.clone()).is_ok());
        let mut secret = value.clone();
        secret["api_key"] = json!("canary");
        assert!(serde_json::from_value::<Acceptance>(secret).is_err());
        let mut invalid = value;
        invalid["status"] = json!("ready");
        assert!(serde_json::from_value::<Acceptance>(invalid).is_err());
    }
}
