//! Location pricing: source override, location default, then installation default.
use super::*;
#[derive(Serialize, FromRow)]
pub struct Rule {
    pub id: Uuid,
    pub area_id: Option<Uuid>,
    pub country_code: String,
    pub state_code: String,
    pub city_id: String,
    pub location_name: String,
    pub source_id: Option<Uuid>,
    #[serde(with = "rust_decimal::serde::str")]
    pub amount: Decimal,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub area_id: Option<Uuid>,
    #[serde(default)]
    pub country_code: String,
    #[serde(default)]
    pub state_code: String,
    #[serde(default)]
    pub city_id: String,
    pub location_name: String,
    pub source_id: Option<Uuid>,
    pub amount: Option<String>,
    pub reason: String,
}
fn amount(input: &Input) -> Result<Option<Decimal>> {
    if input.reason.trim().is_empty()
        || input.reason.len() > 300
        || input.location_name.trim().is_empty()
        || input.location_name.len() > 300
    {
        return Err(Error::Invalid(
            "A location name and change reason are required".into(),
        ));
    }
    let named = input.country_code.len() == 2
        && input.country_code.bytes().all(|c| c.is_ascii_uppercase())
        && [&input.state_code, &input.city_id]
            .iter()
            .all(|s| !s.trim().is_empty() && s.len() <= 200);
    if !(input.area_id.is_some()
        && input.country_code.is_empty()
        && input.state_code.is_empty()
        && input.city_id.is_empty()
        || input.area_id.is_none() && named)
    {
        return Err(Error::Invalid(
            "Choose a mapped area or a country, region and city".into(),
        ));
    }
    input
        .amount
        .as_ref()
        .map(|s| {
            let value: Decimal = s
                .parse()
                .map_err(|_| Error::Invalid("Invalid delivery fee".into()))?;
            if value < Decimal::ZERO || value > Decimal::from(1000000) || value.scale() > 2 {
                return Err(Error::Invalid(
                    "Fee must be 0–1000000 with at most two decimals".into(),
                ));
            }
            Ok(value)
        })
        .transpose()
}
impl Service {
    pub async fn fee_rules(&self) -> Result<Vec<Rule>> {
        Ok(sqlx::query_as("SELECT * FROM fulfillment.delivery_fee_rules ORDER BY location_name,source_id NULLS FIRST").fetch_all(&self.pool).await?)
    }
    pub async fn save_fee_rule(
        &self,
        input: Input,
        who: &domain_admin_iam::Identity,
    ) -> Result<()> {
        who.require("fulfillment.settings.write")?;
        let value = amount(&input)?;
        let mut tx = domain_inventory::begin(&self.pool).await?;
        // Serialize rule edits, including concurrent creates of the same scope.
        sqlx::query("SELECT id FROM fulfillment.delivery_fee_settings WHERE id FOR UPDATE")
            .execute(&mut *tx)
            .await?;
        if let Some(id) = input.area_id {
            if !sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM inventory.delivery_areas WHERE id=$1)",
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await?
            {
                return Err(Error::NotFound);
            }
        }
        if let Some(id) = input.source_id {
            if !sqlx::query_scalar::<_, bool>(
                "SELECT EXISTS(SELECT 1 FROM inventory.inventory_sources WHERE id=$1)",
            )
            .bind(id)
            .fetch_one(&mut *tx)
            .await?
            {
                return Err(Error::NotFound);
            }
        }
        let old:Option<Rule>=sqlx::query_as("DELETE FROM fulfillment.delivery_fee_rules WHERE area_id IS NOT DISTINCT FROM $1 AND country_code=$2 AND state_code=$3 AND city_id=$4 AND source_id IS NOT DISTINCT FROM $5 RETURNING *")
            .bind(input.area_id).bind(&input.country_code).bind(&input.state_code).bind(&input.city_id).bind(input.source_id).fetch_optional(&mut *tx).await?;
        let id = old.as_ref().map(|r| r.id).unwrap_or_else(Uuid::new_v4);
        if let Some(value) = value {
            sqlx::query("INSERT INTO fulfillment.delivery_fee_rules(id,area_id,country_code,state_code,city_id,location_name,source_id,amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8)")
                .bind(id).bind(input.area_id).bind(&input.country_code).bind(&input.state_code).bind(&input.city_id).bind(&input.location_name).bind(input.source_id).bind(value).execute(&mut *tx).await?;
        }
        domain_admin_iam::Service::audit(&mut tx,Some(who.user.id),"admin.delivery_fee_rule.updated",id,json!({"before":old,"amount":value.map(|v|v.to_string()),"area_id":input.area_id,"country_code":input.country_code,"state_code":input.state_code,"city_id":input.city_id,"source_id":input.source_id,"reason":input.reason})).await?;
        tx.commit().await?;
        Ok(())
    }
}
/// Mapped rules precede named rules at each level of the hierarchy.
pub async fn resolve(
    tx: &mut Tx<'_>,
    area: Option<Uuid>,
    geography: Option<&serde_json::Value>,
    sources: &[Uuid],
) -> Result<Decimal> {
    let country = geography
        .and_then(|g| g["country_code"].as_str())
        .unwrap_or("");
    let state = geography
        .and_then(|g| g["state_code"].as_str())
        .unwrap_or("");
    let city = geography.and_then(|g| g["city_id"].as_str()).unwrap_or("");
    let rules: Vec<Rule> = sqlx::query_as("SELECT * FROM fulfillment.delivery_fee_rules WHERE area_id=$1 OR (area_id IS NULL AND country_code=$2 AND state_code=$3 AND city_id=$4)")
        .bind(area).bind(country).bind(state).bind(city).fetch_all(&mut **tx).await?;
    let public: Decimal =
        sqlx::query_scalar("SELECT amount FROM fulfillment.delivery_fee_settings WHERE id")
            .fetch_one(&mut **tx)
            .await?;
    Ok(highest_fee(&rules, sources, public))
}
fn highest_fee(rules: &[Rule], sources: &[Uuid], public: Decimal) -> Decimal {
    let for_source = |source: Option<Uuid>| {
        rules
            .iter()
            .filter(|r| r.source_id.is_none() || (source.is_some() && r.source_id == source))
            .max_by_key(|r| (r.source_id.is_some(), r.area_id.is_some()))
            .map(|r| r.amount)
            .unwrap_or(public)
    };
    sources
        .iter()
        .map(|id| for_source(Some(*id)))
        .max()
        .unwrap_or_else(|| for_source(None))
}

pub async fn cart_fee(
    tx: &mut Tx<'_>,
    cart: Uuid,
    area: Option<Uuid>,
    geography: Option<&serde_json::Value>,
) -> Result<Decimal> {
    let sources:Vec<Uuid>=sqlx::query_scalar("SELECT DISTINCT a.source_id FROM inventory.reservation_allocations a JOIN inventory.reservations r USING(cart_id,product_id) WHERE a.cart_id=$1 AND r.expires_at>clock_timestamp()")
        .bind(cart).fetch_all(&mut **tx).await?;
    resolve(tx, area, geography, &sources).await
}
#[cfg(test)]
mod tests {
    use super::*;
    fn rule(mapped: bool, source: Option<Uuid>, amount: i64) -> Rule {
        Rule {
            id: Uuid::new_v4(),
            area_id: mapped.then(Uuid::new_v4),
            country_code: "EG".into(),
            state_code: "C".into(),
            city_id: "123".into(),
            location_name: "Test".into(),
            source_id: source,
            amount: Decimal::from(amount),
        }
    }
    #[test]
    fn highest_applicable_fee_respects_source_then_location_and_zero() {
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let public = Decimal::from(20);
        assert_eq!(highest_fee(&[], &[a, b], public), public);
        let mut rules = vec![rule(false, None, 30)];
        assert_eq!(highest_fee(&rules, &[a, b], public), Decimal::from(30));
        rules.push(rule(true, None, 40));
        assert_eq!(highest_fee(&rules, &[a, b], public), Decimal::from(40));
        rules.push(rule(false, Some(a), 50));
        assert_eq!(highest_fee(&rules, &[a, b], public), Decimal::from(50));
        // Mapped warehouse override wins over its named override, even at zero.
        rules.push(rule(true, Some(a), 0));
        assert_eq!(highest_fee(&rules, &[a], public), Decimal::ZERO);
        assert_eq!(highest_fee(&rules, &[a, b], public), Decimal::from(40));
        rules.push(rule(true, Some(b), 0));
        assert_eq!(highest_fee(&rules, &[a, b], public), Decimal::ZERO);
        assert_eq!(highest_fee(&rules, &[], public), Decimal::from(40));
        // Unused warehouses do not affect the fee.
        rules.push(rule(true, Some(Uuid::new_v4()), 999));
        assert_eq!(highest_fee(&rules, &[a, b], public), Decimal::ZERO);
    }
    #[test]
    fn zero_is_explicit_and_missing_inherits() {
        let mut input = Input {
            area_id: Some(Uuid::new_v4()),
            country_code: String::new(),
            state_code: String::new(),
            city_id: String::new(),
            location_name: "Area".into(),
            source_id: None,
            amount: Some("0".into()),
            reason: "Update".into(),
        };
        assert_eq!(amount(&input).unwrap(), Some(Decimal::ZERO));
        input.amount = None;
        assert_eq!(amount(&input).unwrap(), None);
        for invalid in ["-1", "1.001", "1000001", "NaN", ""] {
            input.amount = Some(invalid.into());
            assert!(amount(&input).is_err());
        }
    }
}
