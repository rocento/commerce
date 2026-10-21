//! Operator-only diagnostics from the fixed AI service, with audit and no caching.
use crate::{
    assistant,
    identity::{self, ApiError},
};
use axum::{
    extract::Request,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone)]
struct App {
    identity: identity::App,
    assistant: Option<assistant::App>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Filters {
    limit: Option<u8>,
    hours: Option<u16>,
    outcome: Option<String>,
    request_id: Option<Uuid>,
    cursor: Option<String>,
}
impl Filters {
    fn validate(&self) -> Result<(), Error> {
        if self.limit.is_some_and(|v| v == 0 || v > 50)
            || self.hours.is_some_and(|v| v == 0 || v > 168)
            || self.outcome.as_ref().is_some_and(|v| {
                !["completed", "unavailable", "disconnected", "denied"].contains(&v.as_str())
            })
            || self.cursor.as_ref().is_some_and(|v| v.len() > 100)
        {
            return Err(Error::Invalid("Choose valid tracking filters".into()));
        }
        Ok(())
    }
}

#[derive(Deserialize, Serialize)]
struct Row {
    request_id: Uuid,
    created_at: chrono::DateTime<chrono::Utc>,
    outcome: String,
    latency_ms: i64,
    conversation_id: Option<Uuid>,
    route: String,
    intent: Option<String>,
    model: Option<String>,
    model_calls: i64,
    input_tokens: i64,
    output_tokens: i64,
    question_preview: Option<String>,
    report_available: bool,
}
#[derive(Deserialize, Serialize)]
struct Listing {
    capture_enabled: bool,
    retention_days: u8,
    items: Vec<Row>,
    next_cursor: Option<String>,
}
#[derive(Deserialize, Serialize)]
struct Stage {
    stage: String,
    data: Value,
}
#[derive(Deserialize, Serialize)]
struct Report {
    version: u8,
    request_id: Uuid,
    truncated: bool,
    redacted: bool,
    events: Vec<Stage>,
}

impl Report {
    fn valid_for(&self, request_id: Uuid) -> bool {
        self.request_id == request_id && matches!(self.version, 1 | 2) && self.events.len() <= 96
    }
}

pub fn router(identity: identity::App, assistant: Option<assistant::App>) -> Router {
    Router::new()
        .route("/v1/admin/assistant/tracking", get(list))
        .route("/v1/admin/assistant/tracking/live", get(live))
        .route(
            "/v1/admin/assistant/tracking/settings",
            get(capture_read).put(capture_save),
        )
        .route("/v1/admin/assistant/tracking/{id}", get(detail))
        .route("/v1/admin/assistant/tracking/{id}/export", get(export))
        .layer(middleware::from_fn(private_response))
        .with_state(App {
            identity,
            assistant,
        })
}
async fn private_response(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert("cache-control", "no-store, private".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    response
}
fn unavailable() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        Json(
            json!({"error":"Assistant tracking unavailable. Check AI storage and migration 008."}),
        ),
    )
        .into_response()
}
async fn forward(
    a: App,
    headers: HeaderMap,
    filters: Filters,
    id: Option<Uuid>,
    exporting: bool,
) -> Result<Response, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&headers, "admin_session"))
        .await?;
    who.require("assistant.tracking.read")?;
    if exporting {
        who.require("assistant.tracking.export")?;
    }
    filters.validate()?;
    let Some(service) = &a.assistant else {
        return Ok(unavailable());
    };
    infra_auth::rate_limit(
        &a.identity.admins.pool,
        &format!("assistant-tracking:{}", who.user.id),
        120,
    )
    .await?;
    let mut tx = a.identity.admins.pool.begin().await?;
    domain_admin_iam::Service::audit(
        &mut tx,
        Some(who.user.id),
        if exporting {
            "assistant.tracking.export_requested"
        } else {
            "assistant.tracking.read_requested"
        },
        id.unwrap_or(service.tenant),
        json!({"scope":"installation","detail":id.is_some()}),
    )
    .await?;
    tx.commit().await?;
    let now = chrono::Utc::now().timestamp();
    let claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "ai-service".into(),
        tenant: service.tenant,
        sub: None,
        sid: None,
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "tracking_read".into(),
    };
    let path = id.map_or_else(
        || "/v1/tracking".to_string(),
        |v| format!("/v1/tracking/{v}"),
    );
    let mut request = service
        .client
        .get(format!("http://assistant-ingress:8080{path}"));
    if id.is_none() {
        request = request.query(&filters);
    }
    let fetched = request
        .bearer_auth(service.sign(&claims)?)
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    let Ok(mut upstream) = fetched else {
        return Ok(unavailable());
    };
    if !upstream.status().is_success() {
        return Ok(match upstream.status().as_u16() {
            404 => (
                StatusCode::NOT_FOUND,
                Json(json!({"error":"Report was not captured or has expired."})),
            )
                .into_response(),
            422 => (
                StatusCode::BAD_REQUEST,
                Json(json!({"error":"Invalid tracking filters or cursor."})),
            )
                .into_response(),
            _ => unavailable(),
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = upstream.chunk().await.map_err(|_| Error::Internal)? {
        if bytes.len() + chunk.len() > 1_500_000 {
            return Ok(unavailable());
        }
        bytes.extend(chunk);
    }
    let mut response = if let Some(request_id) = id {
        let Ok(report) = serde_json::from_slice::<Report>(&bytes) else {
            return Ok(unavailable());
        };
        if !report.valid_for(request_id) {
            return Ok(unavailable());
        }
        Json(report).into_response()
    } else {
        let Ok(listing) = serde_json::from_slice::<Listing>(&bytes) else {
            return Ok(unavailable());
        };
        if listing.items.len() > 50 {
            return Ok(unavailable());
        }
        Json(listing).into_response()
    };
    response
        .headers_mut()
        .insert("cache-control", "no-store, private".parse().unwrap());
    response
        .headers_mut()
        .insert("x-content-type-options", "nosniff".parse().unwrap());
    if exporting {
        response.headers_mut().insert(
            "content-disposition",
            format!("attachment; filename=\"assistant-{}.json\"", id.unwrap())
                .parse()
                .unwrap(),
        );
    }
    Ok(response)
}
async fn list(
    State(a): State<App>,
    headers: HeaderMap,
    Query(filters): Query<Filters>,
) -> Result<Response, ApiError> {
    forward(a, headers, filters, None, false).await
}
async fn detail(
    State(a): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    forward(a, headers, Filters::default(), Some(id), false).await
}
async fn export(
    State(a): State<App>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    forward(a, headers, Filters::default(), Some(id), true).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tracking_versions_preserve_evidence_and_keep_existing_bounds() {
        let request_id = Uuid::from_u128(42);
        for version in [1, 2] {
            let value = json!({
                "version": version, "request_id": request_id,
                "redacted": true, "truncated": false,
                "events": [{"stage": "final_result", "data": {
                    "completion": {"version": 1, "status": "unverified"},
                    "measurements": {"request_duration_ms": 12},
                    "_journey": {"eventId": "event-2", "spanId": "span-1", "parentSpanId": null}
                }}]
            });
            let mut report: Report = serde_json::from_value(value.clone()).unwrap();
            assert!(report.valid_for(request_id));
            assert_eq!(serde_json::to_value(&report).unwrap(), value);
            assert!(!report.valid_for(Uuid::from_u128(43)));
            for unsupported in [0, 3, 255] {
                report.version = unsupported;
                assert!(!report.valid_for(request_id));
            }
            report.version = version;
            report.events = (0..97)
                .map(|_| Stage {
                    stage: "test".into(),
                    data: json!({}),
                })
                .collect();
            assert!(!report.valid_for(request_id));
        }
    }
    #[test]
    fn invalid_filters_are_rejected() {
        for filters in [
            Filters {
                limit: Some(0),
                ..Default::default()
            },
            Filters {
                hours: Some(169),
                ..Default::default()
            },
            Filters {
                outcome: Some("bogus".into()),
                ..Default::default()
            },
        ] {
            assert!(filters.validate().is_err());
        }
        assert!(Filters::default().validate().is_ok());
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CaptureInput {
    enabled: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct CaptureStatus {
    enabled: bool,
    editable: bool,
    source: String,
}
async fn capture_forward(
    a: App,
    headers: HeaderMap,
    input: Option<CaptureInput>,
) -> Result<Response, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&headers, "admin_session"))
        .await?;
    who.require("assistant.tracking.read")?;
    if input.is_some() {
        who.require("assistant.settings.write")?;
    }
    let Some(service) = &a.assistant else {
        return Ok(unavailable());
    };
    infra_auth::rate_limit(
        &a.identity.admins.pool,
        &format!("assistant-capture:{}", who.user.id),
        30,
    )
    .await?;
    if let Some(body) = &input {
        let mut tx = a.identity.admins.pool.begin().await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "assistant.tracking.update_requested",
            service.tenant,
            json!({"enabled":body.enabled}),
        )
        .await?;
        tx.commit().await?;
    }
    let now = chrono::Utc::now().timestamp();
    let claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "ai-service".into(),
        tenant: service.tenant,
        sub: None,
        sid: None,
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: if input.is_some() {
            "provider_settings_write"
        } else {
            "tracking_read"
        }
        .into(),
    };
    let url = "http://assistant-ingress:8080/v1/provider-settings/tracking";
    let request = if let Some(body) = input {
        service.client.post(url).json(&body)
    } else {
        service.client.get(url)
    };
    let Ok(mut response) = request
        .bearer_auth(service.sign(&claims)?)
        .timeout(Duration::from_secs(5))
        .send()
        .await
    else {
        return Ok(unavailable());
    };
    if !response.status().is_success() {
        return Ok(if response.status().as_u16() == 409 {
            (
                StatusCode::CONFLICT,
                Json(json!({"error":"Tracking is locked by deployment configuration."})),
            )
                .into_response()
        } else {
            unavailable()
        });
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| Error::Internal)? {
        if bytes.len() + chunk.len() > 4096 {
            return Ok(unavailable());
        }
        bytes.extend(chunk);
    }
    let Ok(mut status) = serde_json::from_slice::<CaptureStatus>(&bytes) else {
        return Ok(unavailable());
    };
    status.editable = status.editable && who.require("assistant.settings.write").is_ok();
    Ok(Json(status).into_response())
}
async fn capture_read(State(a): State<App>, headers: HeaderMap) -> Result<Response, ApiError> {
    capture_forward(a, headers, None).await
}
async fn capture_save(
    State(a): State<App>,
    headers: HeaderMap,
    Json(input): Json<CaptureInput>,
) -> Result<Response, ApiError> {
    capture_forward(a, headers, Some(input)).await
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LiveQuery {
    cursor: Option<String>,
}
#[derive(Deserialize, Serialize)]
struct LiveEvent {
    sequence: u64,
    request_id: Uuid,
    kind: String,
    data: Value,
}
#[derive(Deserialize, Serialize)]
struct LiveBatch {
    cursor: String,
    reset: bool,
    capture_enabled: bool,
    events: Vec<LiveEvent>,
}
async fn live(
    State(a): State<App>,
    headers: HeaderMap,
    Query(query): Query<LiveQuery>,
) -> Result<Response, ApiError> {
    let who = a
        .identity
        .admins
        .authenticate(identity::cookie(&headers, "admin_session"))
        .await?;
    who.require("assistant.tracking.read")?;
    if query.cursor.as_ref().is_some_and(|v| {
        v.len() > 100
            || !v
                .bytes()
                .all(|b| b.is_ascii_hexdigit() || b == b'-' || b == b':')
    }) {
        return Err(Error::Invalid("Invalid live cursor".into()).into());
    }
    let Some(service) = &a.assistant else {
        return Ok(unavailable());
    };
    infra_auth::rate_limit(
        &a.identity.admins.pool,
        &format!("assistant-live:{}", who.user.id),
        120,
    )
    .await?;
    // Audit the subscription opening; continuations still authenticate and check permission.
    if query.cursor.is_none() {
        let mut tx = a.identity.admins.pool.begin().await?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "assistant.tracking.live_requested",
            service.tenant,
            json!({"scope":"installation"}),
        )
        .await?;
        tx.commit().await?;
    }
    let now = chrono::Utc::now().timestamp();
    let claims = assistant::Claims {
        iss: "commerce-assistant".into(),
        aud: "ai-service".into(),
        tenant: service.tenant,
        sub: None,
        sid: None,
        request_id: Uuid::new_v4(),
        iat: now,
        exp: now + 45,
        scope: "tracking_read".into(),
    };
    let fetched = service
        .client
        .get("http://assistant-ingress:8080/v1/tracking/live")
        .query(&query)
        .bearer_auth(service.sign(&claims)?)
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    let Ok(mut upstream) = fetched else {
        return Ok(unavailable());
    };
    if !upstream.status().is_success() {
        return Ok(unavailable());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = upstream.chunk().await.map_err(|_| Error::Internal)? {
        if bytes.len() + chunk.len() > 1_500_000 {
            return Ok(unavailable());
        }
        bytes.extend(chunk);
    }
    let Ok(batch) = serde_json::from_slice::<LiveBatch>(&bytes) else {
        return Ok(unavailable());
    };
    if batch.events.len() > 128
        || batch.cursor.len() > 100
        || batch
            .events
            .iter()
            .any(|e| !["stage", "finished"].contains(&e.kind.as_str()))
    {
        return Ok(unavailable());
    }
    Ok(Json(batch).into_response())
}
