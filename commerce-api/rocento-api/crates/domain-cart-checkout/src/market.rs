//! Exact settlement and selling quanta. Inventory continues to count indivisible sellable units.
use super::*;
use rust_decimal::prelude::ToPrimitive;
use serde_json::Value;

#[derive(Clone, Serialize, Deserialize, FromRow)]
#[serde(deny_unknown_fields)]
pub struct Configuration {
    pub enabled: bool,
    pub currency: String,
    pub version: i64,
    pub region: String,
    pub industry: String,
}
pub async fn configuration(tx: &mut Tx<'_>) -> Result<Configuration> {
    Ok(sqlx::query_as("SELECT enabled,currency,version,region,industry FROM cart_checkout.market_configuration WHERE singleton").fetch_one(&mut **tx).await?)
}
pub fn exact_money(value: Decimal, currency: &str) -> Result<Decimal> {
    if !["USD", "EGP"].contains(&currency)
        || value < Decimal::ZERO
        || value.scale() > 2 && value.round_dp(2) != value
    {
        return Err(Error::Invalid("MARKET_MONEY_INVALID: use nonnegative decimal amounts with two minor-unit digits in USD or EGP".into()));
    }
    Ok(value)
}
pub async fn currency(tx: &mut Tx<'_>) -> Result<String> {
    let currency = configuration(tx).await?.currency;
    let fee_currency: String =
        sqlx::query_scalar("SELECT currency FROM fulfillment.delivery_fee_settings WHERE id")
            .fetch_one(&mut **tx)
            .await?;
    if fee_currency != currency {
        return Err(Error::Invalid("DELIVERY_CURRENCY_MISMATCH".into()));
    }
    Ok(currency)
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Piece,
    Pack,
    Case,
    Weight,
    Volume,
    VariableWeight,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum MeasureUnit {
    Piece,
    Kg,
    Litre,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SellingRule {
    pub kind: Kind,
    pub measure_unit: MeasureUnit,
    #[serde(with = "rust_decimal::serde::str")]
    pub measure_per_unit: Decimal,
    pub minimum: i32,
    pub maximum: i32,
    pub increment: i32,
    /// Variable-weight goods stay unavailable until a final-weight lifecycle exists.
    pub estimated_weight: Option<String>,
    pub final_weight: Option<String>,
    /// Explicit restriction classification. The current pack never activates regulated goods.
    pub regulated: bool,
}
impl SellingRule {
    pub fn validate(&self) -> Result<()> {
        if self.measure_per_unit <= Decimal::ZERO
            || self.measure_per_unit > Decimal::from(1_000_000)
            || self.measure_per_unit.scale() > 6
            || self.minimum < 1
            || self.maximum > 1_000_000
            || self.maximum < self.minimum
            || self.increment < 1
            || self.increment > self.maximum
            || matches!(self.kind, Kind::Piece | Kind::Pack | Kind::Case)
                && (self.measure_unit != MeasureUnit::Piece
                    || self.measure_per_unit.fract() != Decimal::ZERO)
            || matches!(self.kind, Kind::Weight | Kind::VariableWeight)
                && self.measure_unit != MeasureUnit::Kg
            || self.kind == Kind::Volume && self.measure_unit != MeasureUnit::Litre
            || self.kind != Kind::VariableWeight
                && (self.estimated_weight.is_some() || self.final_weight.is_some())
            || [&self.estimated_weight, &self.final_weight]
                .iter()
                .any(|v| {
                    v.as_ref().is_some_and(|s| {
                        s.len() > 30
                            || s.parse::<Decimal>()
                                .map_or(true, |n| n <= Decimal::ZERO || n.scale() > 6)
                    })
                })
        {
            return Err(Error::Invalid("SELLING_RULE_INVALID".into()));
        }
        Ok(())
    }
    pub fn quantity(&self, count: i32) -> Result<()> {
        self.validate()?;
        if self.regulated {
            return Err(Error::Invalid("REGULATED_REVIEW_REQUIRED".into()));
        }
        if self.kind == Kind::VariableWeight {
            return Err(Error::Invalid("FINAL_WEIGHT_WORKFLOW_REQUIRED".into()));
        }
        if count < self.minimum
            || count > self.maximum
            || (count - self.minimum) % self.increment != 0
        {
            return Err(Error::Invalid("SELLING_QUANTITY_INVALID".into()));
        }
        Ok(())
    }
    pub fn count_for(&self, quantity: Decimal) -> Result<i32> {
        self.validate()?;
        let count = quantity
            .checked_div(self.measure_per_unit)
            .ok_or_else(|| Error::Invalid("SELLING_QUANTITY_INVALID".into()))?;
        if count.fract() != Decimal::ZERO {
            return Err(Error::Invalid("FRACTIONAL_SELLING_UNIT".into()));
        }
        let count = count
            .to_i32()
            .ok_or_else(|| Error::Invalid("SELLING_QUANTITY_INVALID".into()))?;
        self.quantity(count)?;
        if self.measure_per_unit * Decimal::from(count) != quantity {
            return Err(Error::Invalid("FRACTIONAL_SELLING_UNIT".into()));
        }
        Ok(count)
    }
}
pub async fn rule(tx: &mut Tx<'_>, product: Uuid) -> Result<Option<SellingRule>> {
    let value: Option<Value> =
        sqlx::query_scalar("SELECT rule FROM cart_checkout.selling_rules WHERE product_id=$1")
            .bind(product)
            .fetch_optional(&mut **tx)
            .await?;
    value
        .map(|v| {
            serde_json::from_value(v).map_err(|_| Error::Invalid("SELLING_RULE_INVALID".into()))
        })
        .transpose()
}
pub async fn validate_product(tx: &mut Tx<'_>, p: &Product, count: i32) -> Result<()> {
    if ["regulated", "requires_prescription", "age_restricted"]
        .iter()
        .any(|key| {
            p.attributes
                .get(key)
                .is_some_and(|value| value != &Value::Bool(false))
        })
    {
        return Err(Error::Invalid("REGULATED_REVIEW_REQUIRED".into()));
    }
    let config = configuration(tx).await?;
    if p.currency != config.currency {
        return Err(Error::Invalid(
            "CURRENCY_MISMATCH: no currency conversion is available".into(),
        ));
    }
    exact_money(p.price, &config.currency)?;
    if let Some(r) = rule(tx, p.id).await? {
        // Restrictions remain enforced when the opt-in is disabled.
        r.quantity(count)?;
        validate_basis(p, &r)?;
        if !config.enabled {
            return Err(Error::Invalid("MARKET_RULES_DISABLED".into()));
        }
    }
    Ok(())
}
pub fn validate_basis(p: &Product, r: &SellingRule) -> Result<()> {
    let direct = match r.measure_unit {
        MeasureUnit::Kg => p.unit == "kg",
        MeasureUnit::Litre => p.unit == "L",
        MeasureUnit::Piece => p.unit == "each",
    };
    if !(p.unit == "pack" || direct && r.measure_per_unit == Decimal::ONE) {
        return Err(Error::Invalid("SELLING_PRICE_BASIS_MISMATCH: measured quanta must be cataloged and stocked as packs, or one whole labeled unit".into()));
    }
    Ok(())
}
pub async fn facts(tx: &mut Tx<'_>, p: &Product) -> Result<Value> {
    let config = configuration(tx).await?;
    let attributes:Value=sqlx::query_scalar("SELECT COALESCE(jsonb_object_agg(e.key,e.value),'{}'::jsonb) FROM jsonb_each($1) e WHERE EXISTS(SELECT 1 FROM attributes.definitions d WHERE d.entity_type='product' AND d.attribute_code=e.key AND (d.is_visible_on_front OR d.used_for_configurations) AND COALESCE(d.metadata->>'status','active')='active' AND NOT EXISTS(SELECT 1 FROM attributes.value_provenance v WHERE v.product_id=$2 AND v.definition_id=d.id AND v.source IN ('AI_INFERRED','DERIVED')))").bind(&p.attributes).bind(p.id).fetch_one(&mut **tx).await?;
    let compatibility_digest = infra_auth::digest(
        &json!({"attributes":p.attributes,"options":p.variant_attributes}).to_string(),
    );
    Ok(
        json!({"market_version":config.version,"policy_pack":{"region":config.region,"industry":config.industry,"regulated_goods_enabled":false,"legal_compliance_claim":false},"compatibility_digest":compatibility_digest,"schema_version":"1.0.0","sku":p.sku,"title":p.name,"unit":p.unit,"category_id":p.category_id,"parent_id":p.parent_id,"selected_options":p.variant_attributes,"attributes":attributes,"currency":p.currency,"selling_rule":rule(tx,p.id).await?,"price_basis":"per_sellable_unit","minor_unit_digits":2}),
    )
}
pub async fn label(tx: &mut Tx<'_>, product: Uuid, legacy: &str) -> Result<String> {
    Ok(match rule(tx, product).await? {
        Some(r) => format!(
            "units of {} {}",
            r.measure_per_unit,
            match r.measure_unit {
                MeasureUnit::Piece => "pieces",
                MeasureUnit::Kg => "kg",
                MeasureUnit::Litre => "litres",
            }
        ),
        None => legacy.into(),
    })
}
pub fn equivalent_facts(a: &Value, b: &Value) -> bool {
    [
        "compatibility_digest",
        "sku",
        "unit",
        "category_id",
        "parent_id",
        "selected_options",
        "attributes",
        "currency",
        "selling_rule",
    ]
    .iter()
    .all(|k| a.get(k) == b.get(k))
}
impl Service {
    pub async fn set_measure(
        &self,
        customer: Option<Uuid>,
        guest: &str,
        product: Uuid,
        amount: &str,
    ) -> Result<Cart> {
        if amount.len() > 30 {
            return Err(Error::Invalid("SELLING_QUANTITY_INVALID".into()));
        }
        let amount = amount
            .parse::<Decimal>()
            .map_err(|_| Error::Invalid("SELLING_QUANTITY_INVALID".into()))?;
        let mut tx = domain_inventory::begin_cart(&self.pool, customer, guest, &[product]).await?;
        let timer = infra_observability::OperationTimer::new(
            infra_observability::Operation::InventoryTransaction,
        );
        let rule = rule(&mut tx, product)
            .await?
            .ok_or_else(|| Error::Invalid("SELLING_RULE_REQUIRED".into()))?;
        let count = rule.count_for(amount)?;
        let p = domain_catalog::Service::checkout_product(&mut tx, product).await?;
        let cart = self
            .set_in(&mut tx, customer, guest, p, count, false)
            .await?;
        let committed = tx.commit().await;
        timer.finish(if committed.is_ok() {
            infra_observability::OperationResult::Success
        } else {
            infra_observability::OperationResult::Error
        });
        committed?;
        Ok(cart)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn weight() -> SellingRule {
        SellingRule {
            kind: Kind::Weight,
            measure_unit: MeasureUnit::Kg,
            measure_per_unit: Decimal::new(25, 2),
            minimum: 1,
            maximum: 40,
            increment: 1,
            estimated_weight: None,
            final_weight: None,
            regulated: false,
        }
    }
    #[test]
    fn exact_money_has_no_implicit_fx() {
        for currency in ["USD", "EGP"] {
            assert!(exact_money(Decimal::new(1001, 2), currency).is_ok());
            assert!(exact_money(Decimal::new(1001, 3), currency).is_err());
        }
        assert!(exact_money(Decimal::ONE, "EUR").is_err());
    }
    #[test]
    fn physical_measure_maps_to_exact_inventory_quanta() {
        let r = weight();
        assert_eq!(r.count_for(Decimal::new(75, 2)).unwrap(), 3);
        assert!(r.count_for(Decimal::new(76, 2)).is_err());
        assert!(r.count_for(Decimal::ZERO).is_err());
        assert!(r.count_for(Decimal::from(11)).is_err());
    }
    #[test]
    fn pack_and_restricted_rules_fail_closed() {
        let mut r = weight();
        r.minimum = 2;
        r.increment = 2;
        assert!(r.quantity(3).is_err());
        assert!(r.quantity(4).is_ok());
        r.regulated = true;
        assert!(r.quantity(4).is_err());
        r.regulated = false;
        r.kind = Kind::VariableWeight;
        assert!(r.quantity(4).is_err());
    }
}
