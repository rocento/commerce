//! Admin-only provider configuration; keys are forwarded only to the fixed AI service.
use crate::{
    assistant,
    identity::{self, ApiError},
};
use axum::{
    extract::{rejection::JsonRejection, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone)]
struct App {
    identity: identity::App,
    assistant: Option<assistant::App>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SettingsInput {
    enabled: bool,
    model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    api_key: Option<String>,
    #[serde(default)]
    clear_key: bool,
}
impl SettingsInput {
    fn validate(&self) -> Result<(), Error> {
        if self.model.is_empty()
            || self.model.len() > 100
            || !self
                .model
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
            || !self.model.as_bytes()[0].is_ascii_alphanumeric()
        {
            return Err(Error::Invalid("Enter a valid OpenAI model ID".into()));
        }
        if let Some(key) = &self.api_key {
            if key.len() > 512
                || !key.bytes().all(|b| b.is_ascii_graphic())
                || (self.clear_key && !key.is_empty())
            {
                return Err(Error::Invalid(
                    "Enter a valid API key or choose to remove it".into(),
                ));
            }
        }
        Ok(())
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct SettingsStatus {
    enabled: bool,
    provider: String,
    model: String,
    key_configured: bool,
    source: String,
    editable: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TestStatus {
    ok: bool,
    message: String,
}

pub fn router(identity: identity::App, assistant: Option<assistant::App>) -> Router {
    Router::new()
        .route("/v1/admin/assistant/settings", get(read).put(save))
        .route(
            "/v1/admin/assistant/settings/test",
            axum::routing::post(test),
        )
        .with_state(App {
            identity,
            assistant,
        })
}
fn unavailable() -> Response {
    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":"AI settings service is unavailable. Check the assistant service connection and persistent settings storage."}))).into_response()
}
async fn forward(
    a: &App,
    headers: &HeaderMap,
    input: Option<SettingsInput>,
    testing: bool,
) -> Result<Response, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(headers, "admin_session"))
        .await?;
    let writing = input.is_some();
    who.require(if writing {
        "assistant.settings.write"
    } else {
        "assistant.settings.read"
    })?;
    let Some(assistant) = &a.assistant else {
        return Ok(unavailable());
    };
    if let Some(body) = &input {
        body.validate()?;
    }
    if writing {
        infra_auth::rate_limit(
            &a.identity.admins.pool,
            &format!("assistant-settings:{}", who.user.id),
            30,
        )
        .await?;
        // Audit contains only operation and actor. Never serialize the submitted body.
        let mut tx = a.identity.admins.pool.begin().await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            if testing {
                "assistant.settings.test_requested"
            } else {
                "assistant.settings.update_requested"
            },
            assistant.tenant,
            json!({}),
        )
        .await?;
        tx.commit().await?;
    }
    let now = chrono::Utc::now().timestamp();
    let claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "ai-service".into(),
        tenant: assistant.tenant,
        sub: None,
        sid: None,
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: if writing {
            "provider_settings_write"
        } else {
            "provider_settings_read"
        }
        .into(),
    };
    let url = if testing {
        "http://assistant-ingress:8080/v1/provider-settings/test"
    } else {
        "http://assistant-ingress:8080/v1/provider-settings"
    };
    let request = if let Some(body) = input {
        assistant.client.post(url).json(&body)
    } else {
        assistant.client.get(url)
    };
    let result = request
        .bearer_auth(assistant.sign(&claims)?)
        .timeout(Duration::from_secs(25))
        .send()
        .await;
    let mut response = match result {
        Ok(response) => response,
        Err(_) => return Ok(unavailable()),
    };
    if !response.status().is_success() {
        return Ok(match response.status().as_u16() {
            400 | 422 => (StatusCode::BAD_REQUEST, Json(json!({"error":"Check the model and API key. An enabled integration requires a key."}))).into_response(),
            429 => (StatusCode::TOO_MANY_REQUESTS, Json(json!({"error":"A configuration operation is busy. Please retry shortly."}))).into_response(),
            _ => unavailable(),
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Internal)? {
        if bytes.len() + chunk.len() > 4096 {
            return Ok(unavailable());
        }
        bytes.extend(chunk);
    }
    // Deserialize explicit public schemas so a provider response cannot echo credentials.
    let mut response = if testing {
        match serde_json::from_slice::<TestStatus>(&bytes) {
            Ok(value) => Json(value).into_response(),
            Err(_) => return Ok(unavailable()),
        }
    } else {
        match serde_json::from_slice::<SettingsStatus>(&bytes) {
            Ok(value) => Json(value).into_response(),
            Err(_) => return Ok(unavailable()),
        }
    };
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    Ok(response)
}
async fn read(State(a): State<App>, headers: HeaderMap) -> Result<Response, ApiError> {
    forward(&a, &headers, None, false).await
}
async fn save(
    State(a): State<App>,
    headers: HeaderMap,
    input: Result<Json<SettingsInput>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(body) = input.map_err(|_| Error::Invalid("Invalid provider settings".into()))?;
    forward(&a, &headers, Some(body), false).await
}
async fn test(
    State(a): State<App>,
    headers: HeaderMap,
    input: Result<Json<SettingsInput>, JsonRejection>,
) -> Result<Response, ApiError> {
    let Json(body) = input.map_err(|_| Error::Invalid("Invalid provider settings".into()))?;
    forward(&a, &headers, Some(body), true).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_validation_does_not_echo_secrets() {
        let input = SettingsInput {
            enabled: true,
            model: "gpt-5.6-luna".into(),
            api_key: Some("private\ncanary".into()),
            clear_key: false,
        };
        let error = input.validate().unwrap_err().to_string();
        assert!(!error.contains("canary"));
        assert!(SettingsInput {
            api_key: None,
            ..input
        }
        .validate()
        .is_ok());
    }
    #[test]
    fn public_status_rejects_secret_fields() {
        assert!(serde_json::from_value::<SettingsStatus>(json!({"enabled":true,"provider":"openai","model":"model","source":"admin","editable":true,"key_configured":true,"api_key":"canary"})).is_err());
    }
}
