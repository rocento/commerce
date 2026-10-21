//! Opt-in safe HTTP errors for assistant and browser proposal boundaries.
use axum::{
    body::Body,
    http::{header, StatusCode},
    response::Response,
};
use serde::Serialize;
use uuid::Uuid;

#[derive(Clone, Copy)]
pub(crate) struct StaleProposal;

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Code {
    ProviderTimeout,
    ProviderRateLimit,
    ToolUnavailable,
    StaleProposal,
    AuthenticationNeeded,
    UnsupportedAction,
    InternalFailure,
}
#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum Recovery {
    Retry,
    RefreshProposal,
    SignIn,
    ContactSupport,
}
#[derive(Serialize)]
struct Failure {
    code: Code,
    message: &'static str,
    retryable: bool,
    recovery: Recovery,
    request_reference: Uuid,
}

pub(crate) fn decorate(mut response: Response, reference: Uuid, proposal: bool) -> Response {
    let status = response.status();
    if !status.is_client_error() && !status.is_server_error() {
        return response;
    }
    let (code, message, retryable, recovery) = match status {
        StatusCode::UNAUTHORIZED => (Code::AuthenticationNeeded, "Please sign in again to continue.", false, Recovery::SignIn),
        StatusCode::CONFLICT if proposal => (Code::StaleProposal, "This proposal changed. Reload the latest proposal and review it before applying changes.", false, Recovery::RefreshProposal),
        StatusCode::BAD_REQUEST if proposal && response.extensions().get::<StaleProposal>().is_some() => (Code::StaleProposal, "This proposal is out of date. Refresh and review it before applying changes.", false, Recovery::RefreshProposal),
        StatusCode::TOO_MANY_REQUESTS => (Code::ProviderRateLimit, "The assistant is busy. Please wait before retrying.", true, Recovery::Retry),
        StatusCode::SERVICE_UNAVAILABLE | StatusCode::BAD_GATEWAY => (Code::ToolUnavailable, "The requested store service is temporarily unavailable. Please retry.", true, Recovery::Retry),
        StatusCode::GATEWAY_TIMEOUT | StatusCode::REQUEST_TIMEOUT => (Code::ProviderTimeout, "The assistant took too long to respond. Please retry.", true, Recovery::Retry),
        StatusCode::INTERNAL_SERVER_ERROR => (Code::InternalFailure, "The request could not be completed. Please contact support with this reference.", false, Recovery::ContactSupport),
        _ => (Code::UnsupportedAction, "This request is unavailable. Review your request or contact support.", false, Recovery::ContactSupport),
    };
    let failure = Failure {
        code,
        message,
        retryable,
        recovery,
        request_reference: reference,
    };
    tracing::warn!(target: "assistant_audit", request_reference = %reference, code = %serde_json::json!(failure.code), retryable, recovery = %serde_json::json!(failure.recovery), status = status.as_u16(), boundary = if proposal { "proposal" } else { "chat" }, "assistant HTTP failure");
    *response.body_mut() =
        Body::from(serde_json::json!({"error": message, "failure": failure}).to_string());
    response.headers_mut().remove(header::CONTENT_LENGTH);
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::response::IntoResponse;
    use http_body_util::BodyExt;

    #[tokio::test]
    async fn status_mapping_discards_private_details_and_preserves_retry_after() {
        for (status, code, recovery) in [
            (401, "authentication_needed", "sign_in"),
            (409, "stale_proposal", "refresh_proposal"),
            (429, "provider_rate_limit", "retry"),
            (503, "tool_unavailable", "retry"),
            (504, "provider_timeout", "retry"),
            (500, "internal_failure", "contact_support"),
            (403, "unsupported_action", "contact_support"),
        ] {
            let mut response =
                (StatusCode::from_u16(status).unwrap(), "secret-canary").into_response();
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, "900".parse().unwrap());
            let reference = Uuid::new_v4();
            let response = decorate(response, reference, true);
            assert_eq!(response.status().as_u16(), status);
            assert_eq!(response.headers()[header::RETRY_AFTER], "900");
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(value["failure"]["code"], code);
            assert_eq!(value["failure"]["recovery"], recovery);
            assert_eq!(value["failure"]["request_reference"], reference.to_string());
            assert!(!String::from_utf8_lossy(&bytes).contains("secret-canary"));
            let contract: serde_json::Value =
                serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
            let schema = &contract["components"]["schemas"]["AssistantFailure"];
            assert!(schema["properties"]["code"]["enum"]
                .as_array()
                .unwrap()
                .contains(&value["failure"]["code"]));
        }
    }
}
