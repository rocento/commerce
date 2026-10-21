//! Atomic wishlist-to-cart application command and durable request receipts.
use crate::{Cart, Service};
use infra_auth::{Error, Result};
use serde_json::{json, Value};
use uuid::Uuid;

/// Keep the persisted JSON intact so receipts written by older releases replay
/// exactly, independently of current cart state or projection changes.
pub struct TransferReceipt {
    pub result: Value,
    pub replayed: bool,
}

impl Service {
    /// Transfer quantity one for each selected wishlist item in the same
    /// transaction as reservations, cart mutations, replay claim, and receipt.
    pub async fn transfer_wishlist_to_cart(
        &self,
        customer: Uuid,
        request_id: Uuid,
        mut product_ids: Vec<Uuid>,
    ) -> Result<TransferReceipt> {
        if product_ids.is_empty() || product_ids.len() > 200 {
            return Err(Error::Invalid(
                "Transfer must contain 1 to 200 wishlist items".into(),
            ));
        }
        product_ids.sort_unstable();
        if product_ids.windows(2).any(|pair| pair[0] == pair[1]) {
            return Err(Error::Invalid(
                "Transfer contains duplicate wishlist items".into(),
            ));
        }

        let mut tx =
            domain_inventory::begin_cart(&self.pool, Some(customer), "", &product_ids).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        if let Some((saved_ids, result)) = sqlx::query_as::<_, (Vec<Uuid>, Value)>(
            "SELECT product_ids,result FROM cart_checkout.assistant_wishlist_transfers WHERE customer_id=$1 AND request_id=$2",
        )
        .bind(customer)
        .bind(request_id)
        .fetch_optional(&mut *tx)
        .await?
        {
            if saved_ids != product_ids {
                return Err(Error::Invalid(
                    "This request was already used for a different cart action".into(),
                ));
            }
            let committed = tx.commit().await;
            timer.finish(if committed.is_ok() {
                infra_observability::OperationResult::Success
            } else {
                infra_observability::OperationResult::Error
            });
            committed?;
            return Ok(TransferReceipt {
                result,
                replayed: true,
            });
        }

        // Standalone wishlist mutations use this same lock. Acquire it before
        // validating membership so a concurrent removal cannot be transferred.
        sqlx::query("SELECT pg_advisory_xact_lock(7008)")
            .execute(&mut *tx)
            .await?;
        let present: i64 = sqlx::query_scalar(
            "SELECT count(*)::bigint FROM reviews.wishlist WHERE customer_id=$1 AND product_id=ANY($2)",
        )
        .bind(customer)
        .bind(&product_ids)
        .fetch_one(&mut *tx)
        .await?;
        if present != product_ids.len() as i64 {
            return Err(Error::Invalid(
                "Every transferred product must still be in the customer's wishlist".into(),
            ));
        }

        let claimed = sqlx::query(
            "INSERT INTO cart_checkout.assistant_actions(customer_id,request_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        )
        .bind(customer)
        .bind(request_id)
        .execute(&mut *tx)
        .await?;
        if claimed.rows_affected() == 0 {
            return Err(Error::Invalid(
                "This cart action was already attempted. Read the cart before sending a new request."
                    .into(),
            ));
        }

        let wishlist = domain_reviews::Service {
            pool: self.pool.clone(),
        };
        let mut outcomes = Vec::with_capacity(product_ids.len());
        let mut cart = None;
        for product_id in &product_ids {
            let product = domain_catalog::Service::checkout_product(&mut tx, *product_id).await?;
            let name = product.name.clone();
            let cart_id = self
                .mutate_line_in(&mut tx, Some(customer), "", product, 1, true)
                .await?;
            wishlist
                .wish_in(&mut tx, customer, *product_id, false)
                .await?;
            outcomes.push(json!({
                "product_id": product_id,
                "name": name,
                "status": "transferred",
                "detail": "Quantity 1 added to cart and removed from your wishlist.",
            }));
            cart = Some(cart_id);
        }
        let cart = Self::view(&mut tx, cart.ok_or(Error::Internal)?, Some(customer)).await?;
        if product_ids
            .iter()
            .any(|id| !cart.items.iter().any(|item| item.product_id == *id))
        {
            return Err(Error::Invalid(
                "The cart did not confirm a wishlist item".into(),
            ));
        }
        let result = json!({
            "items": outcomes,
            "cart": cart_receipt(&cart),
        });
        sqlx::query(
            "INSERT INTO cart_checkout.assistant_wishlist_transfers(customer_id,request_id,product_ids,result) VALUES($1,$2,$3,$4)",
        )
        .bind(customer)
        .bind(request_id)
        .bind(&product_ids)
        .bind(&result)
        .execute(&mut *tx)
        .await?;
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(TransferReceipt {
            result,
            replayed: false,
        })
    }
}

fn cart_receipt(cart: &Cart) -> Value {
    let items: Vec<_> = cart
        .items
        .iter()
        .map(|item| {
            json!({
                "product_id": item.product_id,
                "name": item.name,
                "price": item.price.to_string(),
                "currency": item.currency,
                "quantity": item.quantity,
                "line_total": item.line_total.to_string(),
            })
        })
        .collect();
    json!({
        "items": items,
        "subtotal": cart.subtotal.to_string(),
        "discount_amount": cart.discount_amount.to_string(),
        "currency": cart.currency,
        "fully_reserved": cart.fully_reserved,
    })
}
