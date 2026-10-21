//! Private receipted cart + wishlist boundary. Each operation is independently
//! transactional; the second requires the first receipt and never compensates it.
use super::{identity, ApiError, App, TOOL_SLOTS};
use axum::{extract::State, http::HeaderMap, Json};
use infra_auth::Error;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    schema_version: String,
    tenant_id: Uuid,
    customer_id: Uuid,
    conversation_id: Uuid,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Destination {
    Cart,
    Wishlist,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Operation {
    schema_version: String,
    action_id: Uuid,
    operation_id: Uuid,
    product_id: Uuid,
    quantity: i32,
    destination: Destination,
    observed_at: i64,
    expires_at: i64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Command {
    schema_version: String,
    scope: Scope,
    request_id: Uuid,
    revision: Uuid,
    actions: [Operation; 2],
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Dispatch {
    schema_version: String,
    command: Command,
    action_id: Uuid,
}

impl Dispatch {
    fn index(&self) -> Result<usize, Error> {
        let c = &self.command;
        if self.schema_version != "1.0"
            || c.schema_version != "1.0"
            || c.scope.schema_version != "1.0"
            || [
                c.scope.tenant_id,
                c.scope.customer_id,
                c.scope.conversation_id,
                c.request_id,
                c.revision,
            ]
            .iter()
            .any(Uuid::is_nil)
            || c.actions[0].destination == c.actions[1].destination
            || c.actions[0].action_id == c.actions[1].action_id
            || c.actions[0].operation_id == c.actions[1].operation_id
            || c.actions.iter().any(|a| {
                a.schema_version != "1.0"
                    || [a.action_id, a.operation_id, a.product_id]
                        .iter()
                        .any(Uuid::is_nil)
                    || !(1..=1_000_000).contains(&a.quantity)
                    || (a.destination == Destination::Wishlist && a.quantity != 1)
                    || a.observed_at < 0
                    || a.expires_at <= a.observed_at
                    || a.expires_at
                        .checked_sub(a.observed_at)
                        .is_none_or(|age| age > 30)
            })
        {
            return Err(Error::Invalid("Invalid compound command".into()));
        }
        c.actions
            .iter()
            .position(|a| a.action_id == self.action_id)
            .ok_or_else(|| Error::Invalid("Unknown compound action".into()))
    }
}

pub fn writes_enabled() -> bool {
    std::env::var("ASSISTANT_COMPOUND_WRITES_ENABLED").as_deref() == Ok("true")
}

async fn authorize(
    a: &App,
    headers: &HeaderMap,
    input: &Dispatch,
    read: bool,
) -> Result<(), Error> {
    input.index()?;
    let scope = format!(
        "compound_{}:{}",
        if read { "read" } else { "write" },
        input.command.scope.conversation_id
    );
    let claims = a.decode(identity::bearer(headers)?, &scope)?;
    let owner = a.customer(&claims).await?;
    if input.command.scope.tenant_id != a.tenant
        || input.command.scope.customer_id != owner
        || input.command.request_id != claims.request_id
    {
        return Err(Error::Forbidden);
    }
    Ok(())
}

pub async fn apply(
    State(a): State<App>,
    headers: HeaderMap,
    Json(input): Json<Dispatch>,
) -> Result<Json<Value>, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    authorize(&a, &headers, &input, false).await?;
    if !writes_enabled() {
        return Err(Error::Forbidden.into());
    }
    Ok(Json(execute(&a, &input).await?))
}

/// Reconciliation remains available with a read-only token when writes are off.
/// A missing receipt is not permission to repeat a command.
pub async fn receipt(
    State(a): State<App>,
    headers: HeaderMap,
    Json(input): Json<Dispatch>,
) -> Result<Json<Value>, ApiError> {
    let _permit = TOOL_SLOTS.try_acquire().map_err(|_| Error::RateLimited)?;
    authorize(&a, &headers, &input, true).await?;
    let c = &input.command;
    let row: Option<(Value, Value)> = sqlx::query_as(
        "SELECT command,receipts FROM cart_checkout.assistant_compound_requests WHERE tenant_id=$1 AND customer_id=$2 AND request_id=$3",
    ).bind(c.scope.tenant_id).bind(c.scope.customer_id).bind(c.request_id)
        .fetch_optional(&a.identity.customers.pool).await?;
    let found = if let Some((command, receipts)) = row {
        if command != json!(c) {
            return Err(Error::Conflict.into());
        }
        receipts.get(input.action_id.to_string()).cloned()
    } else {
        None
    };
    Ok(Json(json!({"schema_version":"1.0", "receipt":found})))
}

async fn execute(a: &App, input: &Dispatch) -> Result<Value, Error> {
    let index = input.index()?;
    let c = &input.command;
    let op = &c.actions[index];
    let pool = &a.identity.customers.pool;
    // Same inventory lock/order as ordinary cart writes and atomic transfers.
    // An exact concurrent replay waits for the first commit and returns its receipt.
    let mut tx = domain_inventory::begin(pool).await?;
    let row: Option<(Value, Value)> = sqlx::query_as(
        "SELECT command,receipts FROM cart_checkout.assistant_compound_requests WHERE tenant_id=$1 AND customer_id=$2 AND request_id=$3 FOR UPDATE",
    ).bind(c.scope.tenant_id).bind(c.scope.customer_id).bind(c.request_id)
        .fetch_optional(&mut *tx).await?;
    let mut receipts = if let Some((command, receipts)) = row {
        if command != json!(c) {
            return Err(Error::Conflict);
        }
        receipts
    } else {
        json!({})
    };
    if let Some(saved) = receipts.get(op.action_id.to_string()) {
        let saved = saved.clone();
        tx.commit().await?;
        return Ok(saved);
    }
    let now = chrono::Utc::now().timestamp();
    if c.actions
        .iter()
        .any(|a| a.observed_at > now || a.expires_at <= now)
    {
        return Err(Error::Invalid("Product revalidation required".into()));
    }
    if index == 1
        && receipts
            .get(c.actions[0].action_id.to_string())
            .and_then(|r| r.get("outcome"))
            .and_then(Value::as_str)
            != Some("succeeded")
    {
        return Err(Error::Invalid("Previous action has not succeeded".into()));
    }
    if receipts.as_object().is_some_and(|r| r.is_empty()) {
        let claimed = sqlx::query(
            "INSERT INTO cart_checkout.assistant_actions(customer_id,request_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        ).bind(c.scope.customer_id).bind(c.request_id).execute(&mut *tx).await?;
        if claimed.rows_affected() != 1 {
            return Err(Error::Conflict);
        }
        sqlx::query(
            "INSERT INTO cart_checkout.assistant_compound_requests(tenant_id,customer_id,request_id,revision,command) VALUES($1,$2,$3,$4,$5)",
        ).bind(c.scope.tenant_id).bind(c.scope.customer_id).bind(c.request_id)
            .bind(c.revision).bind(json!(c)).execute(&mut *tx).await?;
    }

    // Known business rejections roll back ALL domain effects but commit a failed
    // receipt. Database/transport failures never become authoritative failure.
    sqlx::query("SAVEPOINT compound_operation")
        .execute(&mut *tx)
        .await?;
    let outcome = async {
        if index == 0 {
            // Both bound identities must still be sellable before the first write.
            for action in &c.actions {
                let product =
                    domain_catalog::Service::checkout_product(&mut tx, action.product_id).await?;
                if action.destination == Destination::Cart && !product.in_stock {
                    return Err(Error::Invalid("Product unavailable".into()));
                }
            }
        }
        let product = domain_catalog::Service::checkout_product(&mut tx, op.product_id).await?;
        match op.destination {
            Destination::Cart => {
                a.identity
                    .cart
                    .set_in(
                        &mut tx,
                        Some(c.scope.customer_id),
                        "",
                        product,
                        op.quantity,
                        true,
                    )
                    .await?;
            }
            Destination::Wishlist => {
                domain_reviews::Service { pool: pool.clone() }
                    .wish_in(&mut tx, c.scope.customer_id, op.product_id, true)
                    .await?;
            }
        }
        Ok::<(), Error>(())
    }
    .await;
    let status = match outcome {
        Ok(()) => "succeeded",
        Err(Error::Invalid(_)) | Err(Error::NotFound) | Err(Error::Conflict) => {
            sqlx::query("ROLLBACK TO SAVEPOINT compound_operation")
                .execute(&mut *tx)
                .await?;
            "failed"
        }
        Err(error) => return Err(error),
    };
    sqlx::query("RELEASE SAVEPOINT compound_operation")
        .execute(&mut *tx)
        .await?;
    let result = json!({
        "schema_version":"1.0", "scope":c.scope, "revision":c.revision,
        "action_id":op.action_id, "operation_id":op.operation_id,
        "receipt_id":Uuid::new_v4(), "product_id":op.product_id,
        "quantity":op.quantity, "destination":op.destination,
        "outcome":status, "observed_at":chrono::Utc::now().timestamp(),
    });
    receipts[op.action_id.to_string()] = result.clone();
    sqlx::query(
        "UPDATE cart_checkout.assistant_compound_requests SET receipts=$1 WHERE tenant_id=$2 AND customer_id=$3 AND request_id=$4",
    ).bind(receipts).bind(c.scope.tenant_id).bind(c.scope.customer_id).bind(c.request_id)
        .execute(&mut *tx).await?;
    tx.commit().await?;
    tracing::info!(target:"assistant_audit", action="compound_write", outcome=status,
        request_id=%c.request_id, operation_id=%op.operation_id, tenant=%a.tenant);
    Ok(result)
}

#[cfg(test)]
#[path = "assistant_compound_tests.rs"]
mod tests;
