//! A narrowly scoped capability is minted only for an explicit numbered command.
use super::{App, TOOL_SLOTS};
use crate::identity::{self, ApiError};
use axum::{extract::State, http::HeaderMap, Json};
use infra_auth::Error;
use serde::Deserialize;
use serde_json::{json, Value};

pub fn command_order_number(message: &str) -> Option<i64> {
    let normalized = message.trim().to_ascii_lowercase();
    let normalized = normalized.strip_prefix("please ").unwrap_or(&normalized);
    let words: Vec<_> = normalized.split_whitespace().collect();
    let raw = match words.as_slice() {
        ["buy", "again", "order", number]
        | ["reorder", "order", number]
        | ["repeat", "order", number] => *number,
        _ => return None,
    };
    let raw = raw.strip_prefix('#').unwrap_or(raw);
    if raw.is_empty() || !raw.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    raw.parse::<i64>().ok().filter(|n| *n > 0)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub order_number: i64,
}

pub async fn execute(
    State(a): State<App>,
    headers: HeaderMap,
    Json(input): Json<Input>,
) -> Result<Json<Value>, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    if input.order_number <= 0 {
        return Err(Error::Forbidden.into());
    }
    let claims = a.decode(
        identity::bearer(&headers)?,
        &format!("order_reorder:{}", input.order_number),
    )?;
    let customer = a.customer(&claims).await?;
    tracing::info!(target:"assistant_audit",action="order_reorder",outcome="started",request_id=%claims.request_id,tenant=%a.tenant);
    let detail = a
        .identity
        .cart
        .reorder_number(customer, input.order_number, claims.request_id)
        .await?;
    let o = detail.order;
    tracing::info!(target:"assistant_audit",action="order_reorder",outcome="completed",request_id=%claims.request_id,tenant=%a.tenant,order_id=%o.id);
    Ok(Json(
        json!({"id":o.id,"number":o.number,"status":o.status,"subtotal":o.subtotal.to_string(),"discount_amount":o.discount_amount.to_string(),"tax_amount":o.tax_amount.to_string(),"delivery_fee":o.delivery_fee.to_string(),"total":o.total.to_string(),"currency":o.currency,"cancellation_available":domain_orders::transitions(&o.status).contains(&"cancelled"),"shipments":[]}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_explicit_numbered_commands_authorize_reorder() {
        for text in [
            "buy again order 5",
            "reorder order #5",
            "Please repeat order 5",
        ] {
            assert_eq!(command_order_number(text), Some(5));
        }
        for text in [
            "do not buy again order 5",
            "can I buy again order 5?",
            "buy again order 5 and 6",
            "buy again order 0",
            "buy again order -5",
            "buy again order 5 tomorrow",
            "buy again order 9999999999999999999999",
            "what does buy again order 5 mean",
        ] {
            assert_eq!(command_order_number(text), None, "{text}");
        }
    }
}
