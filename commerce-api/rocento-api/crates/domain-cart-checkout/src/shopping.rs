//! Read-only proposals and explicitly approved atomic cart updates, using commerce services.
use super::*;
use crate::error::StaleProposal;
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Shop,
    Optimize,
    BuyAgain,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub struct Goal {
    #[serde(default)]
    pub purpose: String,
    pub budget: Option<String>,
    pub currency: Option<String>,
    #[serde(default)]
    pub all_inclusive: bool,
    #[serde(default)]
    pub budget_exclusive: bool,
    pub people: Option<i32>,
    #[serde(default)]
    pub locked_products: Vec<Uuid>,
    #[serde(default)]
    pub excluded_products: Vec<Uuid>,
    #[serde(default)]
    pub locked_brands: Vec<String>,
    #[serde(default)]
    pub allow_substitutions: bool,
    pub delivery_date: Option<String>,
    #[serde(default)]
    pub assumptions: Vec<String>,
    #[serde(default)]
    pub unresolved: Vec<String>,
    pub saving_target: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Selection {
    pub product_id: Uuid,
    pub quantity: i32,
    pub replaces: Option<Uuid>,
    pub min_price: Option<String>,
    pub max_price: Option<String>,
    #[serde(default)]
    pub exclusive_max: bool,
    #[serde(default)]
    pub exclusive_min: bool,
    #[serde(default)]
    pub required_attributes: BTreeMap<String, Value>,
    #[serde(default)]
    pub reason: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Draft {
    pub task_id: Uuid,
    pub task_revision: i64,
    pub source_revision: i64,
    pub mode: Mode,
    #[serde(default)]
    pub auto_select: bool,
    pub goal: Goal,
    pub location_id: Option<Uuid>,
    pub order_id: Option<Uuid>,
    #[serde(default)]
    pub selections: Vec<Selection>,
}
#[derive(Serialize, Deserialize, PartialEq)]
pub struct Totals {
    pub subtotal: String,
    pub discount: String,
    pub merchandise_total: String,
    pub tax: Option<String>,
    pub delivery: Option<String>,
    pub payable: Option<String>,
    pub currency: String,
    pub promotions: Vec<String>,
}
#[derive(Serialize, Deserialize)]
pub struct ProposalLine {
    pub selection: Selection,
    pub product: Option<Product>,
    pub previous: Option<Product>,
    pub historical_price: Option<String>,
    pub available: i64,
}
#[derive(Serialize, Deserialize, PartialEq)]
pub struct QuotedItem {
    pub product_id: Uuid,
    pub name: String,
    pub sku: String,
    pub unit: String,
    pub quantity: i32,
    pub price: String,
    pub currency: String,
    pub line_total: String,
    pub variant_attributes: Value,
}
#[derive(Serialize, Deserialize)]
pub struct Proposal {
    #[serde(default)]
    pub delivery_check: Option<domain_fulfillment::market_delivery::DateCheck>,
    #[serde(default)]
    pub market_facts: BTreeMap<Uuid, Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<crate::execution::Receipt>,
    pub id: Uuid,
    pub draft: Draft,
    pub expires_at: DateTime<Utc>,
    pub lines: Vec<ProposalLine>,
    pub current_items: Vec<QuotedItem>,
    pub resulting_items: Vec<QuotedItem>,
    pub before: Totals,
    pub after: Totals,
    pub savings: Option<String>,
    pub issues: Vec<String>,
    pub notes: Vec<String>,
    pub can_apply: bool,
    pub applied: bool,
}
fn within_price_limits(selection: &Selection, price: Decimal) -> Result<bool> {
    if selection.exclusive_min && selection.min_price.is_none() {
        return Err(Error::Invalid("Exclusive minimum requires a price".into()));
    }
    let min = selection.min_price.as_deref().map(money).transpose()?;
    let max = selection.max_price.as_deref().map(money).transpose()?;
    Ok(
        !min.is_some_and(|v| price < v || (selection.exclusive_min && price == v))
            && !max.is_some_and(|v| price > v || (selection.exclusive_max && price == v)),
    )
}

fn money(raw: &str) -> Result<Decimal> {
    let value: Decimal = raw
        .parse()
        .map_err(|_| Error::Invalid("Invalid monetary constraint".into()))?;
    if value < Decimal::ZERO || value.scale() > 2 || value > Decimal::from(1_000_000_000) {
        return Err(Error::Invalid("Invalid monetary constraint".into()));
    }
    Ok(value)
}
fn validate(d: &Draft) -> Result<()> {
    if d.selections.len() > 30
        || d.goal.purpose.len() > 500
        || d.goal.locked_products.len() > 200
        || d.goal.excluded_products.len() > 200
        || d.goal.locked_brands.len() > 20
        || d.goal.assumptions.len() > 20
        || d.goal.unresolved.len() > 20
        || d.goal
            .assumptions
            .iter()
            .chain(&d.goal.unresolved)
            .chain(&d.goal.locked_brands)
            .any(|s| s.len() > 300)
        || d.goal.people.is_some_and(|n| !(1..=1000).contains(&n))
        || d.goal.delivery_date.as_ref().is_some_and(|s| s.len() > 100)
        || d.goal
            .currency
            .as_ref()
            .is_some_and(|s| s.len() != 3 || !s.bytes().all(|b| b.is_ascii_uppercase()))
        || d.selections.iter().any(|s| {
            !(1..=1_000_000).contains(&s.quantity)
                || s.reason.len() > 350
                || s.required_attributes.len() > 20
                || json!(s.required_attributes).to_string().len() > 4000
        })
        || d.selections
            .iter()
            .map(|s| s.product_id)
            .collect::<BTreeSet<_>>()
            .len()
            != d.selections.len()
    {
        return Err(Error::Invalid(
            "Invalid or oversized shopping proposal".into(),
        ));
    }
    for v in [&d.goal.budget, &d.goal.saving_target]
        .into_iter()
        .flatten()
    {
        money(v)?;
    }
    for selection in &d.selections {
        for value in [&selection.min_price, &selection.max_price]
            .into_iter()
            .flatten()
        {
            money(value)?;
        }
    }
    Ok(())
}
// Conservative equivalence: same category, selling unit, exact variant and factual attributes.
// Missing pack/size facts are not evidence of equivalent amounts.
fn equivalent(a: &Product, b: &Product, goal: &Goal) -> bool {
    let mut left = a.attributes.clone();
    let mut right = b.attributes.clone();
    let brand = a
        .attributes
        .get("brand")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !goal
        .locked_brands
        .iter()
        .any(|v| v.eq_ignore_ascii_case(brand))
    {
        if let Some(v) = left.as_object_mut() {
            v.remove("brand");
        }
        if let Some(v) = right.as_object_mut() {
            v.remove("brand");
        }
    }
    a.category_id == b.category_id
        && a.currency == b.currency
        && a.unit == b.unit
        && a.variant_attributes == b.variant_attributes
        && left == right
        && (left.get("pack_size").is_some()
            || left.get("size").is_some()
            || (a.name == b.name
                && matches!(a.unit.as_str(), "kg" | "g" | "l" | "ml" | "lb" | "oz")))
}
async fn equivalent_amount(
    tx: &mut Tx<'_>,
    a: &Product,
    aq: i32,
    b: &Product,
    bq: i32,
    goal: &Goal,
) -> Result<bool> {
    let ar = crate::market::rule(tx, a.id).await?;
    let br = crate::market::rule(tx, b.id).await?;
    match (ar, br) {
        (Some(ar), Some(br)) => {
            if ar.quantity(aq).is_err()
                || br.quantity(bq).is_err()
                || ar.measure_unit != br.measure_unit
                || ar.measure_per_unit * Decimal::from(aq)
                    != br.measure_per_unit * Decimal::from(bq)
            {
                return Ok(false);
            }
            let mut a = a.clone();
            let mut b = b.clone();
            b.unit = a.unit.clone();
            // Only explicit packaging/physical amount facts may differ; identity/compatibility attributes remain exact.
            for p in [&mut a, &mut b] {
                if let Some(attrs) = p.attributes.as_object_mut() {
                    for key in ["pack_size", "weight_grams", "volume_ml"] {
                        attrs.remove(key);
                    }
                    attrs.insert("pack_size".into(), json!("verified_equal_physical_amount"));
                }
            }
            Ok(equivalent(&a, &b, goal))
        }
        (None, None) => Ok(aq == bq && equivalent(a, b, goal)),
        _ => Ok(false),
    }
}
impl Service {
    async fn quoted_items(tx: &mut Tx<'_>, rows: &BTreeMap<Uuid, i32>) -> Result<Vec<QuotedItem>> {
        let mut items = Vec::new();
        for (id, quantity) in rows {
            match domain_catalog::Service::checkout_product(tx, *id).await {
                Ok(p) => items.push(QuotedItem {
                    product_id: p.id,
                    name: p.name,
                    sku: p.sku,
                    unit: crate::market::label(tx, p.id, &p.unit).await?,
                    quantity: *quantity,
                    price: p.price.to_string(),
                    currency: p.currency,
                    line_total: (p.price * Decimal::from(*quantity)).to_string(),
                    variant_attributes: p.variant_attributes,
                }),
                Err(Error::NotFound) => (),
                Err(e) => return Err(e),
            }
        }
        Ok(items)
    }
    pub async fn shopping_cart(&self, customer: Option<Uuid>, guest: &str) -> Result<Uuid> {
        let mut tx = self.pool.begin().await?;
        let id = Self::resolve(&mut tx, customer, guest).await?;
        tx.commit().await?;
        Ok(id)
    }
    pub(crate) async fn shopping_owner(
        tx: &mut Tx<'_>,
        cart: Uuid,
        customer: Option<Uuid>,
    ) -> Result<()> {
        let owner: Option<Uuid> =
            sqlx::query_scalar("SELECT customer_id FROM cart_checkout.carts WHERE id=$1")
                .bind(cart)
                .fetch_optional(&mut **tx)
                .await?
                .ok_or(Error::NotFound)?;
        market_context::for_cart(tx, cart).await?;
        if owner != customer {
            return Err(Error::Forbidden);
        }
        Ok(())
    }
    pub async fn shopping_context(
        &self,
        cart: Uuid,
        customer: Option<Uuid>,
        task: Uuid,
    ) -> Result<Value> {
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        Self::shopping_owner(&mut tx, cart, customer).await?;
        let revision: i64 =
            sqlx::query_scalar("SELECT revision FROM cart_checkout.carts WHERE id=$1")
                .bind(cart)
                .fetch_one(&mut *tx)
                .await?;
        let saved: Option<(i64, Value, bool)> = sqlx::query_as("SELECT revision,draft,cancelled FROM cart_checkout.shopping_tasks WHERE id=$1 AND cart_id=$2")
            .bind(task).bind(cart).fetch_optional(&mut *tx).await?;
        let view = Self::view(&mut tx, cart, customer).await?;
        let locations: Vec<Value> = sqlx::query_scalar("SELECT jsonb_build_object('id',id,'label',label,'is_default',is_default) FROM customers.customer_locations WHERE customer_id=$1 ORDER BY is_default DESC,id LIMIT 20")
            .bind(customer).fetch_all(&mut *tx).await?;
        let latest: Option<Uuid> = sqlx::query_scalar("SELECT id FROM cart_checkout.basket_proposals WHERE task_id=$1 AND cart_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1")
            .bind(task).bind(cart).fetch_optional(&mut *tx).await?;
        let proposed_items:Vec<Value>=sqlx::query_scalar("SELECT jsonb_build_object('product_id',line->'selection'->>'product_id','name',line->'product'->>'name','quantity',line->'selection'->'quantity') FROM cart_checkout.basket_proposals p CROSS JOIN LATERAL jsonb_array_elements(p.quote->'lines') line WHERE p.id=$1 AND p.cart_id=$2 LIMIT 30").bind(latest).bind(cart).fetch_all(&mut *tx).await?;
        let execution_enabled = crate::execution::enabled(&mut tx).await?;
        let market = crate::market::configuration(&mut tx).await?;
        let selling_units: Vec<Value> = if market.enabled {
            sqlx::query_scalar("SELECT jsonb_build_object('product_id',r.product_id,'rule',r.rule,'price_basis','per_sellable_unit') FROM cart_checkout.selling_rules r JOIN catalog.storefront_products p ON p.id=r.product_id WHERE p.active ORDER BY EXISTS(SELECT 1 FROM cart_checkout.items i WHERE i.cart_id=$1 AND i.product_id=r.product_id) DESC,r.product_id LIMIT 50").bind(cart).fetch_all(&mut *tx).await?
        } else {
            vec![]
        };
        let fulfillment_capabilities =
            domain_fulfillment::capabilities::for_cart(&mut tx, cart).await?;
        let mut result = json!({"fulfillment_capabilities":fulfillment_capabilities,"fulfillment_availability_endpoint":"/v1/fulfillment/availability","execution_enabled":execution_enabled,"cart":view,"source_revision":revision,"task_revision":saved.as_ref().map(|s|s.0).unwrap_or(0),"draft":saved.as_ref().map(|s|&s.1),"cancelled":saved.as_ref().is_some_and(|s|s.2),"locations":locations,"proposal_id":latest,"proposed_items":proposed_items,"supported_payment_methods":["cod"],"delivery_slots_available":fulfillment_capabilities.scheduled_delivery_enabled});
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        result["market"] = json!(market);
        result["selling_units"] = json!(selling_units);
        result["selling_units_exhaustive"] = json!(false);
        result["fulfillment_availability"] = if let Some(customer) = customer {
            domain_fulfillment::plans::availability(&self.pool, customer).await?
        } else {
            Value::Null
        };
        Ok(result)
    }
    pub async fn cancel_shopping(&self, cart: Uuid, task: Uuid) -> Result<()> {
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        let result = sqlx::query("INSERT INTO cart_checkout.shopping_tasks(id,cart_id,revision,draft,cancelled) VALUES($1,$2,1,'null'::jsonb,true) ON CONFLICT(id) DO UPDATE SET cancelled=true,revision=shopping_tasks.revision+1,updated_at=now() WHERE shopping_tasks.cart_id=$2")
            .bind(task).bind(cart).execute(&mut *tx).await?;
        if result.rows_affected() == 0 {
            return Err(Error::NotFound);
        }
        crate::execution::finish(
            &mut tx,
            cart,
            task,
            crate::execution::State::Cancelled,
            None,
        )
        .await?;
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(())
    }
    pub async fn shopping_proposal(&self, cart: Uuid, id: Uuid) -> Result<Proposal> {
        let (quote,applied): (Value,bool) = sqlx::query_as("SELECT quote,applied_key IS NOT NULL FROM cart_checkout.basket_proposals WHERE id=$1 AND cart_id=$2")
            .bind(id).bind(cart).fetch_optional(&self.pool).await?.ok_or(Error::NotFound)?;
        let mut p: Proposal = serde_json::from_value(quote).map_err(|_| Error::Internal)?;
        p.applied = applied;
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        if let Some(c) = crate::execution::load(&mut tx, cart, p.draft.task_id).await? {
            if c.receipt.proposal_id == p.id {
                p.execution = Some(c.receipt);
            }
        }
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(p)
    }
    pub async fn propose(&self, cart: Uuid, customer: Option<Uuid>, d: Draft) -> Result<Proposal> {
        let enabled: bool = sqlx::query_scalar(
            "SELECT enabled FROM cart_checkout.execution_config WHERE singleton",
        )
        .fetch_one(&self.pool)
        .await?;
        if enabled {
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                self.propose_inner(cart, customer, d, None),
            )
            .await
            .map_err(|_| Error::Internal)?
        } else {
            self.propose_inner(cart, customer, d, None).await
        }
    }
    pub(crate) async fn propose_inner(
        &self,
        cart: Uuid,
        customer: Option<Uuid>,
        mut d: Draft,
        resume_revision: Option<i64>,
    ) -> Result<Proposal> {
        validate(&d)?;
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        sqlx::query("SET LOCAL statement_timeout = '5s'")
            .execute(&mut *tx)
            .await?;
        Self::shopping_owner(&mut tx, cart, customer).await?;
        Self::check_revision(&mut tx, cart, d.source_revision).await?;
        let saved: Option<(Uuid,i64,bool)> = sqlx::query_as("SELECT cart_id,revision,cancelled FROM cart_checkout.shopping_tasks WHERE id=$1 FOR UPDATE")
            .bind(d.task_id).fetch_optional(&mut *tx).await?;
        if let Some((owner, revision, cancelled)) = saved {
            if owner != cart {
                return Err(Error::NotFound);
            }
            if cancelled || revision != d.task_revision {
                return Err(Error::Conflict);
            }
        } else if d.task_revision != 0 {
            return Err(Error::Conflict);
        }
        let completed:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cart_checkout.basket_proposals WHERE task_id=$1 AND cart_id=$2 AND applied_key IS NOT NULL)")
            .bind(d.task_id).bind(cart).fetch_one(&mut *tx).await?;
        if completed {
            return Err(Error::Invalid("This shopping task was already applied. Start a new task for further cart changes.".into()));
        }
        let previous = crate::execution::load(&mut tx, cart, d.task_id).await?;
        if let Some(expected) = resume_revision {
            let c = previous.as_ref().ok_or(Error::NotFound)?;
            if c.receipt.revision != expected {
                return Err(Error::Conflict);
            }
            if !c.saved_by_customer
                || c.terminal()
                || c.goal_expires_at <= Utc::now()
                || c.revalidations >= c.max_revalidations
                || c.failed_verifications >= c.max_failed_verifications
            {
                return Err(Error::Invalid("Saved goal needs your input or has expired. Review its constraints or start a new task.".into()));
            }
        }
        let mut historical = BTreeMap::new();
        if d.mode == Mode::BuyAgain {
            let owner = customer.ok_or(Error::Unauthorized)?;
            let order = d
                .order_id
                .ok_or_else(|| Error::Invalid("Choose a previous order".into()))?;
            let details = domain_orders::Service::detail_in(&mut tx, order, Some(owner)).await?;
            for i in details.items {
                historical.insert(i.product_id, i.price.to_string());
            }
            if d.auto_select && d.selections.is_empty() {
                let items: Vec<(Uuid,i32)> = sqlx::query_as("SELECT product_id,quantity FROM orders.order_items WHERE order_id=$1 ORDER BY product_id LIMIT 31").bind(order).fetch_all(&mut *tx).await?;
                d.selections = items.into_iter().map(|(product_id,quantity)|Selection {product_id,quantity,replaces:None,min_price:None,max_price:None,exclusive_max:false,exclusive_min:false,required_attributes:BTreeMap::new(),reason:"Requested from your selected previous order; current facts are rechecked.".into()}).collect();
            }
        }
        if d.mode == Mode::Optimize && d.auto_select && d.selections.is_empty() {
            for row in Self::rows(&mut tx, cart).await?.into_iter().take(30) {
                if d.goal.locked_products.contains(&row.product_id) {
                    continue;
                }
                let original =
                    domain_catalog::Service::checkout_product(&mut tx, row.product_id).await?;
                if !d.goal.allow_substitutions {
                    continue;
                }
                let candidates: Vec<Product> = sqlx::query_as("SELECT * FROM catalog.storefront_products WHERE active AND product_type='simple' AND category_id=$1 AND currency=$2 AND unit=$3 AND price<$4 ORDER BY price,id LIMIT 5")
                    .bind(original.category_id).bind(&original.currency).bind(&original.unit).bind(original.price).fetch_all(&mut *tx).await?;
                for candidate in candidates {
                    if !d.goal.excluded_products.contains(&candidate.id)
                        && equivalent_amount(
                            &mut tx,
                            &original,
                            row.quantity,
                            &candidate,
                            row.quantity,
                            &d.goal,
                        )
                        .await?
                        && !Self::rows(&mut tx, cart)
                            .await?
                            .iter()
                            .any(|r| r.product_id == candidate.id)
                        && !d.selections.iter().any(|s| s.product_id == candidate.id)
                        && self
                            .shopping_available(
                                &mut tx,
                                cart,
                                customer,
                                d.location_id,
                                candidate.id,
                            )
                            .await?
                            >= i64::from(row.quantity)
                    {
                        d.selections.push(Selection {product_id:candidate.id,quantity:row.quantity,replaces:Some(original.id),min_price:None,max_price:None,exclusive_max:false,exclusive_min:false,required_attributes:BTreeMap::new(),reason:"Lower current price with matching verified selling unit, size and attributes. Quantities stay unchanged.".into()});
                        break;
                    }
                }
            }
        }
        d.auto_select = false;
        validate(&d)?;
        d.task_revision += 1;
        let mut p = self
            .quote_proposal(&mut tx, cart, customer, d, historical)
            .await?;
        sqlx::query("INSERT INTO cart_checkout.shopping_tasks(id,cart_id,revision,draft) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET revision=$3,draft=$4,updated_at=now()")
            .bind(p.draft.task_id).bind(cart).bind(p.draft.task_revision).bind(json!(p.draft)).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO cart_checkout.basket_proposals(id,cart_id,task_id,task_revision,source_revision,input,quote,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
            .bind(p.id).bind(cart).bind(p.draft.task_id).bind(p.draft.task_revision).bind(p.draft.source_revision).bind(json!(p.draft)).bind(json!(p)).bind(p.expires_at).execute(&mut *tx).await?;
        if let Some(checkpoint) = crate::execution::quote(
            &mut tx,
            cart,
            customer,
            &p,
            previous,
            resume_revision.is_some(),
        )
        .await?
        {
            p.execution = Some(checkpoint.receipt);
            sqlx::query("UPDATE cart_checkout.basket_proposals SET quote=$2 WHERE id=$1")
                .bind(p.id)
                .bind(json!(p))
                .execute(&mut *tx)
                .await?;
        }
        crate::trust::record_proposal(&mut tx, cart, customer, &p).await?;
        infra_events::record(&mut tx,"shopping.proposal_created",json!({"proposal_id":p.id,"cart_id":cart,"task_id":p.draft.task_id,"can_apply":p.can_apply})).await?;
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(p)
    }
    async fn check_revision(tx: &mut Tx<'_>, cart: Uuid, expected: i64) -> Result<()> {
        let actual: i64 =
            sqlx::query_scalar("SELECT revision FROM cart_checkout.carts WHERE id=$1")
                .bind(cart)
                .fetch_one(&mut **tx)
                .await?;
        if actual != expected {
            return Err(StaleProposal::CartRevisionChanged.into());
        }
        Ok(())
    }
    async fn destination(
        tx: &mut Tx<'_>,
        cart: Uuid,
        customer: Option<Uuid>,
        location: Option<Uuid>,
    ) -> Result<(Option<f64>, Option<f64>, Option<Uuid>, bool)> {
        let (lat, lon) = if let Some(id) = location {
            let owner = customer.ok_or(Error::Unauthorized)?;
            sqlx::query_as::<_,(Option<f64>,Option<f64>)>("SELECT latitude,longitude FROM customers.customer_locations WHERE id=$1 AND customer_id=$2").bind(id).bind(owner).fetch_optional(&mut **tx).await?.ok_or(Error::NotFound)?
        } else {
            sqlx::query_as(
                "SELECT delivery_latitude,delivery_longitude FROM cart_checkout.carts WHERE id=$1",
            )
            .bind(cart)
            .fetch_one(&mut **tx)
            .await?
        };
        let (area,configured): (Option<Uuid>,bool) = sqlx::query_as("SELECT inventory.resolve_delivery_area($1,$2),fulfillment.cart_geofencing($3) AND EXISTS(SELECT 1 FROM inventory.delivery_areas)").bind(lat).bind(lon).bind(cart).fetch_one(&mut **tx).await?;
        Ok((lat, lon, area, configured))
    }
    async fn shopping_available(
        &self,
        tx: &mut Tx<'_>,
        cart: Uuid,
        customer: Option<Uuid>,
        location: Option<Uuid>,
        product: Uuid,
    ) -> Result<i64> {
        let (_, _, area, configured) = Self::destination(tx, cart, customer, location).await?;
        if configured && area.is_none() {
            return Ok(0);
        }
        let global: bool = sqlx::query_scalar("SELECT fulfillment.cart_global_delivery($1)")
            .bind(cart)
            .fetch_one(&mut **tx)
            .await?;
        let available: i64 = if global {
            Inventory::global_available_many_in(tx, &[product])
                .await?
                .get(&product)
                .copied()
                .unwrap_or(0)
        } else if configured {
            Inventory::area_available_in(tx, area, product).await?
        } else {
            match Inventory::stock_in(tx, product).await {
                Ok(stock) => stock.available,
                Err(Error::NotFound) => 0,
                Err(e) => return Err(e),
            }
        };
        let own: i64 = if configured {
            sqlx::query_scalar("SELECT COALESCE(SUM(a.quantity),0)::bigint FROM inventory.reservation_allocations a JOIN inventory.reservations r USING(cart_id,product_id) WHERE a.cart_id=$1 AND a.product_id=$2 AND r.expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM inventory.area_stock_links l JOIN inventory.source_stock_links s ON s.stock_id=l.stock_id WHERE l.area_id=$3 AND s.source_id=a.source_id)")
                .bind(cart).bind(product).bind(area).fetch_one(&mut **tx).await?
        } else {
            i64::from(
                Inventory::hold(tx, cart, product)
                    .await?
                    .map(|h| h.quantity)
                    .unwrap_or(0),
            )
        };
        Ok(available + own)
    }
    async fn totals(
        tx: &mut Tx<'_>,
        customer: Option<Uuid>,
        cart: Uuid,
        rows: &BTreeMap<Uuid, i32>,
        location: Option<Uuid>,
        issues: &mut Vec<String>,
    ) -> Result<Totals> {
        let mut lines = Vec::new();
        let currency = crate::market::currency(tx).await?;
        let mut subtotal = Decimal::ZERO;
        for (id, qty) in rows {
            let p = match domain_catalog::Service::checkout_product(tx, *id).await {
                Ok(p) => p,
                Err(Error::NotFound) => {
                    issues.push(format!(
                        "Product {id} is no longer available. Choose or remove it explicitly."
                    ));
                    continue;
                }
                Err(e) => return Err(e),
            };
            if let Err(e) = crate::market::validate_product(tx, &p, *qty).await {
                match e {
                    Error::Invalid(message) => issues.push(message),
                    other => return Err(other),
                }
            }
            subtotal += p.price * Decimal::from(*qty);
            lines.push(domain_pricing_promotions::Line {
                product_id: p.id,
                sku: p.sku,
                category_id: Some(p.category_id),
                price: p.price,
                quantity: *qty,
            });
        }
        let code: Option<String> =
            sqlx::query_scalar("SELECT coupon_code FROM cart_checkout.carts WHERE id=$1")
                .bind(cart)
                .fetch_one(&mut **tx)
                .await?;
        let discounts =
            domain_pricing_promotions::Service::assess(tx, customer, &lines, code, false).await?;
        if let Some(error) = discounts.coupon_error {
            issues.push(error);
        }
        let (lat, lon, area, configured) = Self::destination(tx, cart, customer, location).await?;
        let merchandise = subtotal - discounts.amount;
        let mut totals = Totals {
            subtotal: subtotal.to_string(),
            discount: discounts.amount.to_string(),
            merchandise_total: merchandise.to_string(),
            tax: None,
            delivery: None,
            payable: None,
            currency,
            promotions: discounts.applied.iter().map(|p| p.name.clone()).collect(),
        };
        if configured && area.is_none() {
            issues.push(
                "Choose a serviceable delivery location; this address is not currently covered."
                    .into(),
            );
        }
        if let (Some(latitude), Some(longitude)) = (lat, lon) {
            if !configured || area.is_some() {
                let geography: Option<serde_json::Value> = if let (Some(owner), Some(location)) =
                    (customer, location)
                {
                    sqlx::query_scalar("SELECT geography FROM customers.customer_locations WHERE id=$1 AND customer_id=$2").bind(location).bind(owner).fetch_optional(&mut **tx).await?.flatten()
                } else {
                    None
                };
                // A proposal can change quantities before warehouse allocation. Do not
                // advertise a stale warehouse fee as a confirmed payable total.
                let source_pricing: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM fulfillment.delivery_fee_rules WHERE source_id IS NOT NULL)").fetch_one(&mut **tx).await?;
                if source_pricing {
                    let allocated: Vec<(Uuid, i64)> = sqlx::query_as("SELECT a.product_id,sum(a.quantity)::bigint FROM inventory.reservation_allocations a JOIN inventory.reservations r USING(cart_id,product_id) WHERE a.cart_id=$1 AND r.expires_at>clock_timestamp() GROUP BY a.product_id").bind(cart).fetch_all(&mut **tx).await?;
                    let reserved: BTreeMap<Uuid, i64> = allocated.into_iter().collect();
                    let quantities: BTreeMap<Uuid, i64> =
                        rows.iter().map(|(id, q)| (*id, i64::from(*q))).collect();
                    let cart_area: Option<Uuid> = sqlx::query_scalar("SELECT inventory.resolve_delivery_area(delivery_latitude,delivery_longitude) FROM cart_checkout.carts WHERE id=$1").bind(cart).fetch_one(&mut **tx).await?;
                    if reserved != quantities || cart_area != area {
                        return Ok(totals);
                    }
                }
                let fee =
                    domain_fulfillment::fees::cart_fee(tx, cart, area, geography.as_ref()).await?;
                let tax =
                    domain_tax::Service::assess(tx, latitude, longitude, merchandise, fee).await?;
                totals.payable = Some((merchandise + fee + tax.amount).to_string());
                totals.tax = Some(tax.amount.to_string());
                totals.delivery = Some(fee.to_string());
            }
        }
        Ok(totals)
    }
    async fn quote_proposal(
        &self,
        tx: &mut Tx<'_>,
        cart: Uuid,
        customer: Option<Uuid>,
        d: Draft,
        historical: BTreeMap<Uuid, String>,
    ) -> Result<Proposal> {
        let original: BTreeMap<Uuid, i32> = Self::rows(tx, cart)
            .await?
            .into_iter()
            .map(|r| (r.product_id, r.quantity))
            .collect();
        let mut desired = original.clone();
        let mut issues = d.goal.unresolved.clone();
        let mut before_issues = Vec::new();
        let before = Self::totals(
            tx,
            customer,
            cart,
            &original,
            d.location_id,
            &mut before_issues,
        )
        .await?;
        let mut lines = Vec::new();
        let mut replaced = BTreeSet::new();
        for s in &d.selections {
            let product = match domain_catalog::Service::checkout_product(tx, s.product_id).await {
                Ok(p) => Some(p),
                Err(Error::NotFound) => None,
                Err(e) => return Err(e),
            };
            let mut previous = None;
            if let Some(id) = s.replaces {
                if d.mode != Mode::Optimize
                    || !d.goal.allow_substitutions
                    || !original.contains_key(&id)
                    || !replaced.insert(id)
                    || d.goal.locked_products.contains(&id)
                {
                    issues.push("A replacement conflicts with the authorized substitution scope or a locked product.".into());
                } else {
                    let p = domain_catalog::Service::checkout_product(tx, id).await?;
                    let factual:bool=sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM attributes.value_provenance WHERE product_id=ANY($1) AND source IN ('AI_INFERRED','DERIVED'))").bind(vec![id,s.product_id]).fetch_one(&mut **tx).await?;
                    if !factual
                        || original.contains_key(&s.product_id)
                        || if let Some(b) = &product {
                            !equivalent_amount(tx, &p, original[&id], b, s.quantity, &d.goal)
                                .await?
                        } else {
                            true
                        }
                    {
                        issues.push(format!("Cannot verify an equivalent amount/variant for {}. Quantities and required facts must remain unchanged.",p.name));
                    }
                    previous = Some(p);
                    desired.remove(&id);
                }
            } else if d.mode == Mode::Optimize {
                issues.push("Optimization may only apply reviewed equivalent replacements.".into());
            }
            if d.goal.excluded_products.contains(&s.product_id)
                || (original.contains_key(&s.product_id)
                    && d.goal.locked_products.contains(&s.product_id))
            {
                issues.push("A proposed change affects an excluded or locked product.".into());
            }
            let qty = desired
                .get(&s.product_id)
                .copied()
                .unwrap_or(0)
                .checked_add(s.quantity)
                .ok_or_else(|| Error::Invalid("Quantity too large".into()))?;
            if qty > 1_000_000 {
                return Err(Error::Invalid("Quantity too large".into()));
            }
            desired.insert(s.product_id, qty);
            if let Some(p) = &product {
                if d.mode == Mode::BuyAgain {
                    let old:Option<(String,String,Option<Value>)>=sqlx::query_as("SELECT sku,unit,market_facts FROM orders.order_items WHERE order_id=$1 AND product_id=$2").bind(d.order_id).bind(s.product_id).fetch_optional(&mut **tx).await?;
                    if old
                        .as_ref()
                        .is_some_and(|(sku, unit, _)| sku != &p.sku || unit != &p.unit)
                    {
                        issues.push(format!("{}: the SKU or selling unit changed since the previous order. Remove this line and choose the current product explicitly in a new shopping task.",p.name));
                    }
                }
                if d.mode == Mode::BuyAgain {
                    let stored:Option<Value>=sqlx::query_scalar("SELECT market_facts FROM orders.order_items WHERE order_id=$1 AND product_id=$2").bind(d.order_id).bind(p.id).fetch_optional(&mut **tx).await?.flatten();
                    if let Some(stored) = stored {
                        if !crate::market::equivalent_facts(
                            &stored,
                            &crate::market::facts(tx, p).await?,
                        ) {
                            issues.push(format!("{}: historical options, pack or compatibility facts changed. Choose the current product explicitly in a new task.",p.name));
                        }
                    }
                }
                if !within_price_limits(s, p.price)? {
                    issues.push(format!(
                        "{}: current unit price does not meet the requested limit.",
                        p.name
                    ));
                }
                for (key, value) in &s.required_attributes {
                    let factual: bool=sqlx::query_scalar("SELECT NOT EXISTS(SELECT 1 FROM attributes.value_provenance v JOIN attributes.definitions d ON d.id=v.definition_id WHERE v.product_id=$1 AND d.attribute_code=$2 AND v.source IN ('AI_INFERRED','DERIVED'))").bind(p.id).bind(key).fetch_one(&mut **tx).await?;
                    if !factual
                        || p.attributes
                            .get(key)
                            .or_else(|| p.variant_attributes.get(key))
                            != Some(value)
                    {
                        issues.push(format!("{}: required {} is unverified.", p.name, key));
                    }
                }
            }
            let available = if product.is_some() {
                self.shopping_available(tx, cart, customer, d.location_id, s.product_id)
                    .await?
            } else {
                0
            };
            let mut product = product;
            // Apply the catalog's existing storefront visibility policy before persisting display facts.
            let catalog = domain_catalog::Service {
                pool: self.pool.clone(),
            };
            if let Some(p) = product.as_mut() {
                catalog.visible_attributes(p).await?;
            }
            if let Some(p) = previous.as_mut() {
                catalog.visible_attributes(p).await?;
            }
            lines.push(ProposalLine {
                selection: s.clone(),
                product,
                previous,
                historical_price: historical.get(&s.product_id).cloned(),
                available,
            });
        }
        if desired.len() > 200 {
            return Err(Error::Invalid(
                "A cart can contain at most 200 different products".into(),
            ));
        }
        for (id, qty) in &desired {
            if self
                .shopping_available(tx, cart, customer, d.location_id, *id)
                .await?
                < i64::from(*qty)
            {
                issues.push(format!("Insufficient current stock for product {id}. Availability is not a reservation."));
            }
        }
        let after = Self::totals(tx, customer, cart, &desired, d.location_id, &mut issues).await?;
        if d.goal
            .currency
            .as_ref()
            .is_some_and(|c| c != &after.currency)
        {
            issues.push("The requested currency differs from the cart currency. No conversion is available.".into());
        }
        let comparable = |t: &Totals| {
            if d.goal.all_inclusive {
                t.payable.clone()
            } else {
                Some(t.merchandise_total.clone())
            }
        };
        if d.goal.budget.is_some() && after.currency != "USD" && d.goal.currency.is_none() {
            issues.push("A budget must name the settlement currency explicitly.".into());
        }
        if let Some(limit) = &d.goal.budget {
            match comparable(&after) {
                Some(v) if money(&v)? < money(limit)? || (!d.goal.budget_exclusive && money(&v)? == money(limit)?) => (),
                Some(_) => issues.push("The requested budget cannot be met by this proposal without changing your constraints.".into()),
                None => issues.push("Delivery or tax is unknown; the all-inclusive budget is not verified.".into()),
            }
        }
        let delivery_check = if let Some(date) = &d.goal.delivery_date {
            let check = if crate::market::configuration(tx).await?.enabled {
                domain_fulfillment::market_delivery::check(
                    tx,
                    cart,
                    customer,
                    d.location_id,
                    &desired,
                    date,
                )
                .await?
            } else {
                domain_fulfillment::market_delivery::DateCheck {
                    available: false,
                    reason: domain_fulfillment::market_delivery::Reason::SchedulingDisabled,
                    date: date.clone(),
                    reservation_required: true,
                }
            };
            if !check.available {
                issues.push(format!(
                    "Delivery date unavailable: {}. Choose another date or contact the store.",
                    serde_json::to_value(&check.reason).unwrap_or_default()
                ));
            }
            Some(check)
        } else {
            None
        };
        let savings = if before_issues.is_empty() {
            match (comparable(&before), comparable(&after)) {
                (Some(a), Some(b)) => Some((money(&a)? - money(&b)?).to_string()),
                _ => None,
            }
        } else {
            None
        };
        if let Some(target) = &d.goal.saving_target {
            let saved = savings.as_ref().and_then(|s| s.parse::<Decimal>().ok());
            if saved.is_none_or(|s| s < money(target).unwrap_or(Decimal::MAX)) {
                issues.push("The requested saving is not available among the evaluated equivalent candidates. Keep your constraints or explicitly revise them.".into());
            }
        }
        if d.selections.is_empty() {
            issues.push(
                "No changes are proposed. No verified improvement or matching products were found."
                    .into(),
            );
        }
        if d.mode == Mode::Optimize
            && savings
                .as_ref()
                .and_then(|s| s.parse::<Decimal>().ok())
                .is_none_or(|s| s <= Decimal::ZERO)
        {
            issues.push("This selection does not provide a verified saving after current promotions and fees.".into());
        }
        let mut notes=vec!["Proposed basket only. Existing cart contents are preserved except for explicitly listed replacements. Budget is checked against the resulting cart.".into(),"Prices and availability are revalidated on apply. Checkout requires a separate purchase confirmation; cash on delivery is the only supported method.".into()];
        if after.payable.is_none() {
            notes.push("Total is incomplete: delivery and tax are confirmed after selecting a delivery location. Merchandise total is not the final payable total.".into());
        }
        if d.mode == Mode::BuyAgain {
            let legacy:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM orders.order_items WHERE order_id=$1 AND market_facts IS NULL)").bind(d.order_id).fetch_one(&mut **tx).await?;
            notes.push(if legacy {"Legacy order: historical options and pack facts are incomplete. Review current details; historical equivalence cannot be fully verified."} else {"Historical SKU, options, selling measure and compatibility facts are checked against the immutable order snapshot. Prices and stock are current."}.into());
        }
        if d.mode == Mode::Optimize {
            notes.push("Valid improvement among at most five candidates per evaluated line; not a claim of global optimality.".into());
        }
        issues.sort();
        issues.dedup();
        let mut market_facts = BTreeMap::new();
        for id in desired.keys() {
            match domain_catalog::Service::checkout_product(tx, *id).await {
                Ok(product) => {
                    market_facts.insert(*id, crate::market::facts(tx, &product).await?);
                }
                Err(Error::NotFound) => (),
                Err(e) => return Err(e),
            }
        }
        Ok(Proposal {
            market_facts,
            delivery_check,
            execution: None,
            id: Uuid::new_v4(),
            draft: d,
            expires_at: Utc::now() + chrono::Duration::minutes(5),
            lines,
            current_items: Self::quoted_items(tx, &original).await?,
            resulting_items: Self::quoted_items(tx, &desired).await?,
            before,
            after,
            savings,
            can_apply: issues.is_empty(),
            issues,
            notes,
            applied: false,
        })
    }
    pub async fn apply_proposal(
        &self,
        cart: Uuid,
        customer: Option<Uuid>,
        guest: &str,
        id: Uuid,
        key: Uuid,
    ) -> Result<Cart> {
        self.apply_delegated_proposal(cart, customer, guest, id, key, false)
            .await
    }
    pub async fn apply_delegated_proposal(
        &self,
        cart: Uuid,
        customer: Option<Uuid>,
        guest: &str,
        id: Uuid,
        key: Uuid,
        strict: bool,
    ) -> Result<Cart> {
        let result = self
            .apply_proposal_transaction(cart, customer, guest, id, key, strict)
            .await;
        if let Err(ref error) = result {
            crate::trust::failed(&self.pool, cart, customer, id, key, error).await;
        }
        result
    }
    async fn apply_proposal_transaction(
        &self,
        cart: Uuid,
        customer: Option<Uuid>,
        guest: &str,
        id: Uuid,
        key: Uuid,
        strict: bool,
    ) -> Result<Cart> {
        let mut tx = domain_inventory::begin(&self.pool).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        Self::shopping_owner(&mut tx, cart, customer).await?;
        let authorization =
            crate::trust::authorize(&mut tx, cart, customer, id, key, strict).await?;
        let (quote,applied,expires):(Value,Option<Uuid>,DateTime<Utc>)=sqlx::query_as("SELECT quote,applied_key,expires_at FROM cart_checkout.basket_proposals WHERE id=$1 AND cart_id=$2 FOR UPDATE").bind(id).bind(cart).fetch_optional(&mut *tx).await?.ok_or(Error::NotFound)?;
        if applied.is_some() {
            let view = Self::view(&mut tx, cart, customer).await?;
            let committed = tx.commit().await;
            timer.finish(if committed.is_ok() {
                infra_observability::OperationResult::Success
            } else {
                infra_observability::OperationResult::Error
            });
            committed?;
            return Ok(view);
        }
        let reused:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cart_checkout.basket_proposals WHERE cart_id=$1 AND applied_key=$2)").bind(cart).bind(key).fetch_one(&mut *tx).await?;
        if reused {
            return Err(Error::Conflict);
        }
        let p: Proposal = serde_json::from_value(quote).map_err(|_| Error::Internal)?;
        let current:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM cart_checkout.shopping_tasks WHERE id=$1 AND cart_id=$2 AND revision=$3 AND NOT cancelled)").bind(p.draft.task_id).bind(cart).bind(p.draft.task_revision).fetch_one(&mut *tx).await?;
        if !current || expires <= Utc::now() || !p.can_apply {
            return Err(StaleProposal::ProposalUnavailable.into());
        }
        if let Some(c) = crate::execution::load(&mut tx, cart, p.draft.task_id).await? {
            if c.receipt.state != crate::execution::State::AwaitingConfirmation
                || c.receipt.verdict != crate::execution::Verdict::Pass
                || c.receipt.proposal_id != p.id
                || c.goal_expires_at <= Utc::now()
            {
                return Err(Error::Invalid(
                    "Goal needs revalidation before approval. Review a fresh quote.".into(),
                ));
            }
        }
        if let Err(error) = Self::check_revision(&mut tx, cart, p.draft.source_revision).await {
            crate::execution::stale(&mut tx, cart, p.draft.task_id).await?;
            let committed = tx.commit().await;
            timer.finish(if committed.is_ok() {
                infra_observability::OperationResult::Success
            } else {
                infra_observability::OperationResult::Error
            });
            committed?;
            return Err(error);
        }
        let fresh = self
            .quote_proposal(&mut tx, cart, customer, p.draft.clone(), BTreeMap::new())
            .await?;
        if p.expires_at <= Utc::now()
            || !fresh.can_apply
            || fresh.resulting_items != p.resulting_items
            || fresh.after != p.after
            || fresh.market_facts != p.market_facts
            || reviewed_product_facts(&fresh.lines) != reviewed_product_facts(&p.lines)
        {
            crate::execution::stale(&mut tx, cart, p.draft.task_id).await?;
            let committed = tx.commit().await;
            timer.finish(if committed.is_ok() {
                infra_observability::OperationResult::Success
            } else {
                infra_observability::OperationResult::Error
            });
            committed?;
            return Err(StaleProposal::QuoteFactsChanged.into());
        }
        let (lat, lon, _, _) =
            Self::destination(&mut tx, cart, customer, p.draft.location_id).await?;
        let mut desired: BTreeMap<Uuid, i32> = Self::rows(&mut tx, cart)
            .await?
            .into_iter()
            .map(|r| (r.product_id, r.quantity))
            .collect();
        for s in &p.draft.selections {
            if let Some(old) = s.replaces {
                desired.remove(&old);
            }
            *desired.entry(s.product_id).or_default() += s.quantity;
        }
        // Release and rebuild within the existing inventory transaction; any failure rolls back everything.
        for row in Self::rows(&mut tx, cart).await? {
            Inventory::release(&mut tx, cart, row.product_id, "approved_proposal").await?;
            if !desired.contains_key(&row.product_id) {
                sqlx::query("DELETE FROM cart_checkout.items WHERE cart_id=$1 AND product_id=$2")
                    .bind(cart)
                    .bind(row.product_id)
                    .execute(&mut *tx)
                    .await?;
                infra_events::record(
                    &mut tx,
                    "cart.item_removed",
                    json!({"cart_id":cart,"product_id":row.product_id,"quantity":row.quantity}),
                )
                .await?;
            }
        }
        sqlx::query(
            "UPDATE cart_checkout.carts SET delivery_latitude=$2,delivery_longitude=$3 WHERE id=$1",
        )
        .bind(cart)
        .bind(lat)
        .bind(lon)
        .execute(&mut *tx)
        .await?;
        for (product, quantity) in desired {
            let product = domain_catalog::Service::checkout_product(&mut tx, product).await?;
            self.mutate_line_in(&mut tx, customer, guest, product, quantity, false)
                .await?;
        }
        sqlx::query("UPDATE cart_checkout.carts SET market_delivery_date=$2 WHERE id=$1")
            .bind(cart)
            .bind(&p.draft.goal.delivery_date)
            .execute(&mut *tx)
            .await?;
        let result = Self::view(&mut tx, cart, customer).await?;
        sqlx::query(
            "UPDATE cart_checkout.basket_proposals SET applied_key=$2,applied_cart=$3 WHERE id=$1",
        )
        .bind(id)
        .bind(key)
        .bind(json!(result))
        .execute(&mut *tx)
        .await?;
        crate::execution::finish(
            &mut tx,
            cart,
            p.draft.task_id,
            crate::execution::State::Completed,
            Some(key),
        )
        .await?;
        infra_events::record(
            &mut tx,
            "shopping.cart_applied",
            json!({"proposal_id":id,"cart_id":cart,"task_id":p.draft.task_id,"action_id":key}),
        )
        .await?;
        crate::trust::committed(&mut tx, authorization.as_ref()).await?;
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

// Numeric metadata is additive; all existing product facts still govern approval.
fn reviewed_product_facts(lines: &[ProposalLine]) -> Vec<(Value, Value)> {
    fn facts(product: &Option<Product>) -> Value {
        let mut value = json!(product);
        if let Some(object) = value.as_object_mut() {
            object.remove("entity_id");
        }
        value
    }
    lines
        .iter()
        .map(|line| (facts(&line.product), facts(&line.previous)))
        .collect()
}

#[cfg(test)]
mod strict_price_tests {
    use super::*;

    #[test]
    fn persisted_strict_minimum_is_rechecked_against_current_price() {
        let mut selection: Selection = serde_json::from_value(serde_json::json!({
            "product_id": Uuid::nil(), "quantity": 1, "min_price": "100.00",
            "max_price": "101.00", "exclusive_min": true, "exclusive_max": true
        }))
        .unwrap();
        for (value, expected) in [
            ("99.99", false),
            ("100", false),
            ("100.01", true),
            ("101", false),
        ] {
            assert_eq!(
                within_price_limits(&selection, value.parse().unwrap()).unwrap(),
                expected
            );
        }
        let saved = serde_json::to_value(&selection).unwrap();
        assert_eq!(saved["exclusive_min"], true);
        selection = serde_json::from_value(saved).unwrap();
        assert!(!within_price_limits(&selection, "100".parse().unwrap()).unwrap());
        selection.exclusive_min = false;
        assert!(within_price_limits(&selection, "100".parse().unwrap()).unwrap());
    }

    #[test]
    fn old_drafts_default_to_inclusive_minimum() {
        let selection: Selection = serde_json::from_value(serde_json::json!({
            "product_id": Uuid::nil(), "quantity": 1, "min_price": "100"
        }))
        .unwrap();
        assert!(!selection.exclusive_min);
        assert!(within_price_limits(&selection, "100".parse().unwrap()).unwrap());
    }
}
