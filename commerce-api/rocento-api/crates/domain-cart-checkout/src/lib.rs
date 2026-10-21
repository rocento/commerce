//! Persistent guest/customer carts. Inventory mutations use the inventory transaction boundary.
use domain_catalog::Product;
use domain_inventory::{Service as Inventory, Tx};
use infra_auth::{Error, Result};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
    pub inventory: Inventory,
}
#[derive(FromRow, Clone)]
struct Stored {
    product_id: Uuid,
    sku: String,
    name: String,
    unit: String,
    price: Decimal,
    currency: String,
    quantity: i32,
}
#[derive(Serialize, Deserialize)]
pub struct Item {
    pub product_id: Uuid,
    pub sku: String,
    pub name: String,
    pub unit: String,
    #[serde(with = "rust_decimal::serde::str")]
    pub price: Decimal,
    pub currency: String,
    pub quantity: i32,
    pub reserved_quantity: i32,
    pub available: i64,
    pub expires_at: Option<chrono::DateTime<chrono::Utc>>,
    #[serde(with = "rust_decimal::serde::str")]
    pub line_total: Decimal,
}
#[derive(Serialize, Deserialize)]
pub struct Cart {
    #[serde(default, skip_serializing_if = "entity_id_missing")]
    pub entity_id: i64,
    pub market: market_context::Context,
    #[serde(with = "rust_decimal::serde::str")]
    pub discount_amount: Decimal,
    pub discount_snapshot: Vec<domain_pricing_promotions::Applied>,
    pub coupon_code: Option<String>,
    pub coupon_error: Option<String>,
    pub id: Uuid,
    pub customer_id: Option<Uuid>,
    pub items: Vec<Item>,
    #[serde(with = "rust_decimal::serde::str")]
    pub subtotal: Decimal,
    pub currency: String,
    pub fully_reserved: bool,
}
pub struct Session {
    pub cart: Cart,
    pub guest_token: Option<String>,
}
impl Service {
    /// Read an existing customer's cart without creating, merging or expiring state.
    pub async fn read_customer(&self, customer: Uuid) -> Result<Option<Cart>> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
            .execute(&mut *tx)
            .await?;
        let id: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM cart_checkout.carts WHERE customer_id=$1")
                .bind(customer)
                .fetch_optional(&mut *tx)
                .await?;
        let result = match id {
            Some(id) => Some(Self::view(&mut tx, id, Some(customer)).await?),
            None => None,
        };
        tx.commit().await?;
        Ok(result)
    }

    pub async fn open(&self, customer: Option<Uuid>, guest: &str) -> Result<Session> {
        let mut tx = domain_inventory::begin_cart(&self.pool, customer, guest, &[]).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        let old_guest: Option<Uuid> = if guest.is_empty() {
            None
        } else {
            sqlx::query_scalar("SELECT id FROM cart_checkout.carts WHERE guest_hash=$1")
                .bind(infra_auth::digest(guest))
                .fetch_optional(&mut *tx)
                .await?
        };
        let (id, token) = if let Some(customer) = customer {
            let id=sqlx::query_scalar("INSERT INTO cart_checkout.carts(id,customer_id) VALUES($1,$2) ON CONFLICT(customer_id) DO UPDATE SET updated_at=now() RETURNING id").bind(Uuid::new_v4()).bind(customer).fetch_one(&mut *tx).await?;
            if let Some(guest) = old_guest {
                self.merge(&mut tx, guest, id).await?;
            }
            (id, None)
        } else if let Some(id) = old_guest {
            (id, Some(guest.to_owned()))
        } else {
            let id = Uuid::new_v4();
            let token = infra_auth::token();
            sqlx::query("INSERT INTO cart_checkout.carts(id,guest_hash) VALUES($1,$2)")
                .bind(id)
                .bind(infra_auth::digest(&token))
                .execute(&mut *tx)
                .await?;
            (id, Some(token))
        };
        let cart = Self::view(&mut tx, id, customer).await?;
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(Session {
            cart,
            guest_token: token,
        })
    }
    async fn resolve(tx: &mut Tx<'_>, customer: Option<Uuid>, guest: &str) -> Result<Uuid> {
        let id = if let Some(customer) = customer {
            sqlx::query_scalar("SELECT id FROM cart_checkout.carts WHERE customer_id=$1")
                .bind(customer)
                .fetch_optional(&mut **tx)
                .await?
        } else {
            sqlx::query_scalar("SELECT id FROM cart_checkout.carts WHERE guest_hash=$1")
                .bind(infra_auth::digest(guest))
                .fetch_optional(&mut **tx)
                .await?
        };
        let id = id.ok_or(Error::NotFound)?;
        market_context::for_cart(tx, id).await?;
        Ok(id)
    }
    async fn rows(tx: &mut Tx<'_>, cart: Uuid) -> Result<Vec<Stored>> {
        Ok(sqlx::query_as("SELECT product_id,sku,name,unit,price,currency,quantity FROM cart_checkout.items WHERE cart_id=$1 ORDER BY product_id").bind(cart).fetch_all(&mut **tx).await?)
    }
    async fn save(tx: &mut Tx<'_>, cart: Uuid, row: &Stored) -> Result<()> {
        sqlx::query("INSERT INTO cart_checkout.items(cart_id,product_id,sku,name,unit,price,currency,quantity) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(cart_id,product_id) DO UPDATE SET sku=$3,name=$4,unit=$5,price=$6,currency=$7,quantity=$8").bind(cart).bind(row.product_id).bind(&row.sku).bind(&row.name).bind(&row.unit).bind(row.price).bind(&row.currency).bind(row.quantity).execute(&mut **tx).await?;
        Ok(())
    }
    pub async fn set(
        &self,
        customer: Option<Uuid>,
        guest: &str,
        product: Product,
        quantity: i32,
        add: bool,
    ) -> Result<Cart> {
        let mut tx =
            domain_inventory::begin_cart(&self.pool, customer, guest, &[product.id]).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        let view = self
            .set_in(&mut tx, customer, guest, product, quantity, add)
            .await?;
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(view)
    }
    /// Apply a customer cart change inside an existing inventory transaction.
    /// Callers that expose replayable assistant commands must claim the command
    /// key in this same transaction before calling this method.
    pub async fn set_in(
        &self,
        tx: &mut domain_inventory::Tx<'_>,
        customer: Option<Uuid>,
        guest: &str,
        product: Product,
        quantity: i32,
        add: bool,
    ) -> Result<Cart> {
        let cart = self
            .mutate_line_in(tx, customer, guest, product, quantity, add)
            .await?;
        Self::view(tx, cart, customer).await
    }
    /// Change one line without reading a response. Multi-line commands assemble
    /// their final cart only after all mutations succeed in this transaction.
    pub(crate) async fn mutate_line_in(
        &self,
        tx: &mut domain_inventory::Tx<'_>,
        customer: Option<Uuid>,
        guest: &str,
        product: Product,
        quantity: i32,
        add: bool,
    ) -> Result<Uuid> {
        if !(1..=1000000).contains(&quantity) || !product.active {
            return Err(domain_inventory::invalid(
                "Product is unavailable or quantity is invalid",
            ));
        }
        let product = domain_catalog::Service::checkout_product(tx, product.id).await?;
        let cart = Self::resolve(tx, customer, guest).await?;
        let old: Option<i32> = sqlx::query_scalar(
            "SELECT quantity FROM cart_checkout.items WHERE cart_id=$1 AND product_id=$2",
        )
        .bind(cart)
        .bind(product.id)
        .fetch_optional(&mut **tx)
        .await?;
        let quantity = if add {
            old.unwrap_or(0)
                .checked_add(quantity)
                .ok_or_else(|| domain_inventory::invalid("Quantity too large"))?
        } else {
            quantity
        };
        if quantity > 1000000 {
            return Err(domain_inventory::invalid("Quantity too large"));
        }
        market::validate_product(tx, &product, quantity).await?;
        if old.is_none() {
            let count: i64 =
                sqlx::query_scalar("SELECT count(*) FROM cart_checkout.items WHERE cart_id=$1")
                    .bind(cart)
                    .fetch_one(&mut **tx)
                    .await?;
            if count >= 200 {
                return Err(domain_inventory::invalid(
                    "A cart can contain at most 200 different products",
                ));
            }
        }
        self.inventory
            .reserve(tx, cart, product.id, quantity)
            .await?;
        Self::save(
            tx,
            cart,
            &Stored {
                product_id: product.id,
                sku: product.sku,
                name: product.name,
                unit: product.unit,
                price: product.price,
                currency: product.currency,
                quantity,
            },
        )
        .await?;
        let previous = old.unwrap_or(0);
        let delta = quantity - previous;
        if delta != 0 {
            infra_events::record(
                tx,
                if delta > 0 {
                    "cart.item_added"
                } else {
                    "cart.item_removed"
                },
                json!({"cart_id":cart,"product_id":product.id,"quantity":delta.abs()}),
            )
            .await?;
        }
        Ok(cart)
    }
    pub async fn remove(&self, customer: Option<Uuid>, guest: &str, id: Uuid) -> Result<Cart> {
        self.remove_amount(customer, guest, id, None).await
    }
    /// An explicit quantity is subtracted under the inventory transaction lock.
    pub async fn remove_amount(
        &self,
        customer: Option<Uuid>,
        guest: &str,
        id: Uuid,
        amount: Option<i32>,
    ) -> Result<Cart> {
        if amount.is_some_and(|value| !(1..=1000000).contains(&value)) {
            return Err(domain_inventory::invalid("Quantity is invalid"));
        }
        let mut tx = domain_inventory::begin_cart(&self.pool, customer, guest, &[]).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        let cart = Self::resolve(&mut tx, customer, guest).await?;
        if let Some(amount) = amount {
            let old: Option<i32> = sqlx::query_scalar(
                "SELECT quantity FROM cart_checkout.items WHERE cart_id=$1 AND product_id=$2",
            )
            .bind(cart)
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
            let old =
                old.ok_or_else(|| domain_inventory::invalid("Product is not in your cart"))?;
            if amount > old {
                return Err(domain_inventory::invalid(
                    "Removal exceeds the quantity in your cart",
                ));
            }
            if amount < old {
                let product = domain_catalog::Service::checkout_product(&mut tx, id).await?;
                let view = self
                    .set_in(&mut tx, customer, guest, product, old - amount, false)
                    .await?;
                let committed = tx.commit().await;
                timer.finish(if committed.is_ok() {
                    infra_observability::OperationResult::Success
                } else {
                    infra_observability::OperationResult::Error
                });
                committed?;
                return Ok(view);
            }
        }
        let qty: Option<i32> = sqlx::query_scalar(
            "DELETE FROM cart_checkout.items WHERE cart_id=$1 AND product_id=$2 RETURNING quantity",
        )
        .bind(cart)
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
        Inventory::release(&mut tx, cart, id, "removed").await?;
        if let Some(quantity) = qty {
            infra_events::record(
                &mut tx,
                "cart.item_removed",
                json!({"cart_id":cart,"product_id":id,"quantity":quantity}),
            )
            .await?;
        }
        let view = Self::view(&mut tx, cart, customer).await?;
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(view)
    }
    /// Remove all lines and release their reservations in one transaction.
    pub async fn clear(&self, customer: Uuid) -> Result<Cart> {
        let mut tx = domain_inventory::begin_cart(&self.pool, Some(customer), "", &[]).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        let cart = Self::resolve(&mut tx, Some(customer), "").await?;
        for row in Self::rows(&mut tx, cart).await? {
            Inventory::release(&mut tx, cart, row.product_id, "removed").await?;
            infra_events::record(
                &mut tx,
                "cart.item_removed",
                json!({"cart_id":cart,"product_id":row.product_id,"quantity":row.quantity}),
            )
            .await?;
        }
        sqlx::query("DELETE FROM cart_checkout.items WHERE cart_id=$1")
            .bind(cart)
            .execute(&mut *tx)
            .await?;
        let view = Self::view(&mut tx, cart, Some(customer)).await?;
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(view)
    }
    pub async fn coupon(&self, customer: Option<Uuid>, guest: &str, code: &str) -> Result<Cart> {
        let code = domain_pricing_promotions::normalize_code(code)?;
        let mut tx = domain_inventory::begin_cart(&self.pool, customer, guest, &[]).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        let id = Self::resolve(&mut tx, customer, guest).await?;
        sqlx::query("UPDATE cart_checkout.carts SET coupon_code=$2 WHERE id=$1")
            .bind(id)
            .bind(code)
            .execute(&mut *tx)
            .await?;
        let cart = Self::view(&mut tx, id, customer).await?;
        if let Some(e) = &cart.coupon_error {
            return Err(Error::Invalid(e.clone()));
        }
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(cart)
    }
    async fn merge(&self, tx: &mut Tx<'_>, guest: Uuid, account: Uuid) -> Result<()> {
        let guest_market = market_context::for_cart(tx, guest).await?;
        let account_market = market_context::for_cart(tx, account).await?;
        if guest_market.id != account_market.id {
            return Err(Error::Invalid("CART_MARKET_MISMATCH".into()));
        }
        // Check the combined basket before releasing either cart's holds. The
        // caller keeps both carts locked until this merge commits or rolls back.
        let count: i64 = sqlx::query_scalar(
            "SELECT count(DISTINCT product_id) FROM cart_checkout.items WHERE cart_id=ANY($1)",
        )
        .bind(&[guest, account][..])
        .fetch_one(&mut **tx)
        .await?;
        if count > 200 {
            return Err(domain_inventory::invalid(
                "A cart can contain at most 200 different products",
            ));
        }
        for mut row in Self::rows(tx, guest).await? {
            Inventory::release(tx, guest, row.product_id, "guest_merge").await?;
            let old: Option<i32> = sqlx::query_scalar(
                "SELECT quantity FROM cart_checkout.items WHERE cart_id=$1 AND product_id=$2",
            )
            .bind(account)
            .bind(row.product_id)
            .fetch_optional(&mut **tx)
            .await?;
            // Preserve requested quantities even when expired holds cannot be fully restored.
            let added = row.quantity;
            row.quantity = (row.quantity + old.unwrap_or(0)).min(1000000);
            // Use the destination cart's actual allocation scope, including
            // area/global pools and its own existing hold. A shortage can leave
            // a partial hold; an invalid scope must preserve the account hold.
            let reservation =
                match Inventory::reservable_quantity(tx, account, row.product_id, row.quantity)
                    .await
                {
                    Ok(quantity) => {
                        self.inventory
                            .reserve(tx, account, row.product_id, quantity)
                            .await
                    }
                    Err(error) => Err(error),
                };
            match reservation {
                Ok(()) | Err(Error::Invalid(_)) => (),
                Err(e) => return Err(e),
            }
            Self::save(tx, account, &row).await?;
            infra_events::record(tx,"cart.item_added",json!({"cart_id":account,"product_id":row.product_id,"quantity":added,"reason":"guest_merge"})).await?;
        }
        sqlx::query("UPDATE cart_checkout.carts SET coupon_code=COALESCE(coupon_code,(SELECT coupon_code FROM cart_checkout.carts WHERE id=$1)) WHERE id=$2").bind(guest).bind(account).execute(&mut **tx).await?;
        sqlx::query("DELETE FROM cart_checkout.carts WHERE id=$1")
            .bind(guest)
            .execute(&mut **tx)
            .await?;
        Ok(())
    }
}

mod snapshot;

pub mod checkout;
pub mod error;
pub mod execution;
pub mod market_context;
pub mod reorder;
pub mod shopping;
pub mod wishlist;

impl Service {
    pub async fn bundle(
        &self,
        customer: Option<Uuid>,
        guest: &str,
        parent: Uuid,
        selected: Vec<Uuid>,
    ) -> Result<Cart> {
        if selected.is_empty() || selected.len() > 100 {
            return Err(domain_inventory::invalid("Choose one SKU per bundle group"));
        }
        let mut tx = domain_inventory::begin_cart(&self.pool, customer, guest, &selected).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        sqlx::query("SELECT pg_advisory_xact_lock_shared(2002)")
            .execute(&mut *tx)
            .await?;
        let p: Product = sqlx::query_as(
            "SELECT * FROM catalog.storefront_products WHERE id=$1 AND active AND product_type='bundle'",
        )
        .bind(parent)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Error::NotFound)?;
        let links:Vec<(Uuid,String,i32)>=sqlx::query_as("SELECT child_id,option_label,quantity FROM catalog.product_links WHERE parent_id=$1 ORDER BY position").bind(p.id).fetch_all(&mut *tx).await?;
        let groups: std::collections::HashSet<_> = links.iter().map(|l| &l.1).collect();
        if groups.len() != selected.len()
            || groups.iter().any(|g| {
                links
                    .iter()
                    .filter(|l| &l.1 == *g && selected.contains(&l.0))
                    .count()
                    != 1
            })
            || selected.iter().any(|id| !links.iter().any(|l| l.0 == *id))
        {
            return Err(domain_inventory::invalid(
                "Choose exactly one valid SKU per bundle group",
            ));
        }
        let mut cart = None;
        for id in selected {
            let child = domain_catalog::Service::checkout_product(&mut tx, id).await?;
            let quantity = links.iter().find(|l| l.0 == id).unwrap().2;
            cart = Some(
                self.mutate_line_in(&mut tx, customer, guest, child, quantity, true)
                    .await?,
            );
        }
        let result = Self::view(&mut tx, cart.ok_or(Error::Internal)?, customer).await?;
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(result)
    }
}

impl Service {
    pub async fn set_delivery(
        &self,
        customer: Option<Uuid>,
        guest: &str,
        pin: Option<domain_inventory::areas::Pin>,
    ) -> Result<Cart> {
        if let Some(p) = pin {
            p.validate()?;
        }
        let mut tx = domain_inventory::begin_cart(&self.pool, customer, guest, &[]).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        let cart = Self::resolve(&mut tx, customer, guest).await?;
        let old: (Option<f64>, Option<f64>) = sqlx::query_as(
            "SELECT delivery_latitude,delivery_longitude FROM cart_checkout.carts WHERE id=$1",
        )
        .bind(cart)
        .fetch_one(&mut *tx)
        .await?;
        let next = (pin.map(|p| p.latitude), pin.map(|p| p.longitude));
        if old != next {
            sqlx::query("UPDATE cart_checkout.carts SET delivery_latitude=$2,delivery_longitude=$3 WHERE id=$1").bind(cart).bind(next.0).bind(next.1).execute(&mut *tx).await?;
            for row in Self::rows(&mut tx, cart).await? {
                Inventory::release(&mut tx, cart, row.product_id, "delivery_pin_changed").await?;
                match self
                    .inventory
                    .reserve(&mut tx, cart, row.product_id, row.quantity)
                    .await
                {
                    Ok(()) | Err(Error::Invalid(_)) => (),
                    Err(e) => return Err(e),
                }
            }
        }
        let result = Self::view(&mut tx, cart, customer).await?;
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(result)
    }
}

pub mod trust;

pub mod market;

// Older persisted cart receipts may predate numeric entity identifiers.
fn entity_id_missing(value: &i64) -> bool {
    *value == 0
}
