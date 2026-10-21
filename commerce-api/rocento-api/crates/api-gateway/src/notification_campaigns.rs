//! Unified campaign targeting. The engagement worker owns grants; commerce is read
//! through a bounded pool, and browser observations never manufacture commerce events.
use crate::marketing_notifications::conditions;
use chrono::{DateTime, Duration, Utc};
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use sqlx::{types::Json, PgPool};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AudienceRules {
    pub segment_ids: Vec<Uuid>,
    pub segment_match: String,
    pub trigger_kind: Option<String>,
    pub conditions: conditions::Conditions,
    pub delay_minutes: i64,
    pub lookback_days: i64,
    pub cooldown_hours: i64,
    pub max_deliveries: i32,
    pub suppress_after_purchase: bool,
}
const TRIGGERS: &[&str] = &[
    "visit",
    "product_view",
    "category_view",
    "page_view",
    "search",
    "cart.item_added",
    "cart.item_removed",
    "shopping.proposal_created",
    "shopping.cart_applied",
    "checkout",
    "purchase",
    "order_status",
];
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
impl AudienceRules {
    pub fn validate(&self, audience: &str, product: Option<Uuid>) -> Result<()> {
        let trigger = self.trigger_kind.as_deref();
        if self.segment_ids.len() > 20
            || self.segment_ids.iter().collect::<BTreeSet<_>>().len() != self.segment_ids.len()
            || self.segment_ids.iter().any(Uuid::is_nil)
            || !["all", "any"].contains(&self.segment_match.as_str())
        {
            return Err(invalid(
                "Choose all or any and at most 20 distinct customer segments",
            ));
        }
        if trigger.is_some_and(|kind| !TRIGGERS.contains(&kind))
            || (product.is_some() && trigger != Some("product_view"))
        {
            return Err(invalid(
                "Choose a supported journey event; product selection requires Product viewed",
            ));
        }
        if !(0..=43200).contains(&self.delay_minutes)
            || !(1..=90).contains(&self.lookback_days)
            || !(0..=2160).contains(&self.cooldown_hours)
            || self.delay_minutes >= self.lookback_days * 1440
            || !(1..=100).contains(&self.max_deliveries)
            || (self.max_deliveries > 1 && self.cooldown_hours == 0)
        {
            return Err(invalid("Use delay 0–43200 minutes, lookback 1–90 days, cooldown 0–2160 hours, and 1–100 deliveries; repeated delivery requires a cooldown"));
        }
        if trigger.is_none()
            && (self.max_deliveries != 1 || self.delay_minutes != 0 || self.suppress_after_purchase)
        {
            return Err(invalid("Scheduled audience campaigns deliver once; delay and purchase suppression require a journey event"));
        }
        if audience != "customers"
            && (!self.segment_ids.is_empty()
                || self.suppress_after_purchase
                || trigger.is_some_and(|kind| !["visit", "product_view"].contains(&kind))
                || self.conditions.rules.iter().any(|rule| {
                    rule.field.starts_with("customer.") || rule.field.starts_with("order.")
                }))
        {
            return Err(invalid("Segments, customer/order conditions, purchase suppression, and authenticated journey events require the signed-in customer audience"));
        }
        if audience != "customers" && trigger == Some("visit") && self.max_deliveries != 1 {
            return Err(invalid("Guest store-visit campaigns deliver once per browser; product visits support repeat delivery"));
        }
        conditions::validate(&self.conditions, trigger.unwrap_or(""))
    }
    pub async fn validate_segments(&self, commerce: &PgPool) -> Result<()> {
        if self.segment_ids.is_empty() {
            return Ok(());
        }
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM customers.segments WHERE id=ANY($1) AND definition->>'status'='active'")
            .bind(&self.segment_ids).fetch_one(commerce).await?;
        if count as usize != self.segment_ids.len() {
            return Err(invalid("Choose active, existing customer segments"));
        }
        Ok(())
    }
}

/// Bounded latest browser observations, scoped only to an existing authenticated
/// recipient or random guest cookie. Duplicate event jobs preserve the original time.
pub async fn record_event(
    pool: &PgPool,
    recipient: Uuid,
    kind: &str,
    reference: &str,
    event: Uuid,
    occurred: DateTime<Utc>,
) -> Result<()> {
    sqlx::query("INSERT INTO platform.notification_campaign_events(recipient_id,kind,reference,event_id,occurred_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(recipient_id,kind,reference) DO UPDATE SET event_id=EXCLUDED.event_id,occurred_at=EXCLUDED.occurred_at WHERE platform.notification_campaign_events.occurred_at<EXCLUDED.occurred_at AND platform.notification_campaign_events.event_id<>EXCLUDED.event_id")
        .bind(recipient).bind(kind).bind(reference).bind(event).bind(occurred).execute(pool).await?;
    // One latest event per product, bounded to 100 per recipient.
    sqlx::query("DELETE FROM platform.notification_campaign_events WHERE recipient_id=$1 AND kind='product_view' AND reference IN (SELECT reference FROM platform.notification_campaign_events WHERE recipient_id=$1 AND kind='product_view' ORDER BY occurred_at DESC OFFSET 100)")
        .bind(recipient).execute(pool).await?;
    Ok(())
}

pub async fn touch(app: &crate::identity::App, recipient: Uuid, area: Option<Uuid>) -> Result<()> {
    let active: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform.storefront_notification_publications WHERE audience_rules IS NOT NULL AND withdrawn_at IS NULL AND expires_at>clock_timestamp())")
        .fetch_one(&app.engagement).await?;
    if !active {
        return Ok(());
    }
    // Initial visit is stable across polling, and not joined to another identity.
    sqlx::query("INSERT INTO platform.notification_campaign_events(recipient_id,kind,reference,event_id,occurred_at) SELECT id,'visit','',$2,clock_timestamp() FROM platform.storefront_notification_recipients WHERE id=$1 ON CONFLICT(recipient_id,kind,reference) DO UPDATE SET event_id=EXCLUDED.event_id,occurred_at=EXCLUDED.occurred_at WHERE platform.notification_campaign_events.occurred_at<(SELECT max(published_at) FROM platform.storefront_notification_publications WHERE audience_rules IS NOT NULL AND withdrawn_at IS NULL AND published_at<=clock_timestamp() AND expires_at>clock_timestamp())")
        .bind(recipient).bind(Uuid::new_v4()).execute(&app.engagement).await?;
    if app.engagement_isolated {
        crate::engagement::enqueue(
            &app.engagement,
            format!(
                "campaign:{recipient}:{}:{}",
                area.map(|id| id.to_string()).unwrap_or_default(),
                Utc::now().timestamp() / 30
            ),
            "campaign_evaluate",
            serde_json::json!({"recipient":recipient,"area":area}),
        )
        .await?;
    } else {
        let mut after = None;
        loop {
            after = evaluate(
                CampaignDatabases {
                    engagement: &app.engagement,
                    commerce: &app.engagement_commerce,
                },
                recipient,
                area,
                false,
                after,
                None,
                None,
            )
            .await?;
            if after.is_none() {
                break;
            }
        }
    }
    Ok(())
}

#[derive(sqlx::FromRow)]
struct Candidate {
    id: Uuid,
    audience_rules: Json<AudienceRules>,
    trigger_product_id: Option<Uuid>,
    published_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}
#[derive(sqlx::FromRow)]
struct Delivery {
    delivered_at: DateTime<Utc>,
    delivery_count: i32,
    last_event_id: Option<String>,
}

/// Evaluate at most 100 current campaigns for one recipient. No audience fan-out
/// or collection of customer facts is performed by a public storefront request.
pub struct CampaignDatabases<'a> {
    pub engagement: &'a PgPool,
    pub commerce: &'a PgPool,
}

pub async fn evaluate(
    databases: CampaignDatabases<'_>,
    recipient: Uuid,
    area: Option<Uuid>,
    schedule_jobs: bool,
    after: Option<Uuid>,
    only: Option<Uuid>,
    run_id: Option<Uuid>,
) -> Result<Option<Uuid>> {
    let CampaignDatabases {
        engagement,
        commerce,
    } = databases;
    let mut tx = engagement.begin().await?;
    sqlx::query("SET LOCAL statement_timeout='10s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SET LOCAL lock_timeout='3s'")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock_shared(1040701)")
        .execute(&mut *tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,10409))")
        .bind(recipient.to_string())
        .execute(&mut *tx)
        .await?;
    let subject: Option<(Option<Uuid>,)> = sqlx::query_as("SELECT customer_id FROM platform.storefront_notification_recipients WHERE id=$1 AND (expires_at IS NULL OR expires_at>clock_timestamp())")
        .bind(recipient).fetch_optional(&mut *tx).await?;
    let Some((customer,)) = subject else {
        return Ok(None);
    };
    let now = Utc::now();
    let mut due_jobs = Vec::new();
    let mut candidates: Vec<Candidate> = sqlx::query_as("SELECT n.id,n.audience_rules,n.trigger_product_id,n.published_at,n.expires_at FROM platform.storefront_notification_publications n WHERE n.audience_rules IS NOT NULL AND n.withdrawn_at IS NULL AND n.expires_at>$2 AND (cardinality(n.area_ids)=0 OR $3::uuid=ANY(n.area_ids)) AND (($1::uuid IS NULL AND n.audience IN ('all','guests')) OR ($1::uuid IS NOT NULL AND n.audience IN ('all','customers'))) AND ($4::uuid IS NULL OR n.id>$4) AND ($5::uuid IS NULL OR n.id=$5) ORDER BY n.id LIMIT 101")
        .bind(customer).bind(now).bind(area).bind(after).bind(only).fetch_all(&mut *tx).await?;
    let has_more = candidates.len() > 100;
    candidates.truncate(100);
    let next = if has_more {
        candidates.last().map(|c| c.id)
    } else {
        None
    };
    for candidate in candidates {
        let rules = &candidate.audience_rules.0;
        if candidate.published_at > now {
            due_jobs.push((candidate.id, candidate.published_at));
            continue;
        }

        let previous:Option<Delivery>=sqlx::query_as("SELECT delivered_at,delivery_count,last_event_id FROM platform.storefront_notification_deliveries WHERE recipient_id=$1 AND publication_id=$2")
            .bind(recipient).bind(candidate.id).fetch_optional(&mut *tx).await?;
        if previous
            .as_ref()
            .is_some_and(|d| d.delivery_count >= rules.max_deliveries)
        {
            continue;
        }
        if let Some(due) = previous
            .as_ref()
            .map(|d| d.delivered_at + Duration::hours(rules.cooldown_hours))
            .filter(|due| *due > now)
        {
            if due < candidate.expires_at {
                due_jobs.push((candidate.id, due));
            }
            continue;
        }
        if !rules.segment_ids.is_empty() {
            let Some(customer) = customer else { continue };
            let active:i64=sqlx::query_scalar("SELECT count(*) FROM customers.segments WHERE id=ANY($1) AND definition->>'status'='active'").bind(&rules.segment_ids).fetch_one(commerce).await?;
            if active as usize != rules.segment_ids.len() {
                continue;
            }
            let matched = domain_customers::segments::Service {
                pool: commerce.clone(),
            }
            .matching_ids(customer, &rules.segment_ids)
            .await?;
            if (rules.segment_match == "all" && matched.len() != rules.segment_ids.len())
                || (rules.segment_match == "any" && matched.is_empty())
            {
                continue;
            }
        }
        let event = if let Some(kind) = &rules.trigger_kind {
            let from = std::cmp::max(
                now - Duration::days(rules.lookback_days),
                candidate.published_at,
            );
            let browser: Option<crate::customer_journey::Event> = if kind == "product_view"
                || (kind == "visit" && customer.is_none())
            {
                let row:Option<(Uuid,DateTime<Utc>,String,String,Uuid)>=sqlx::query_as("SELECT e.event_id,e.occurred_at,e.reference,COALESCE(p.name,''),COALESCE(p.id,'00000000-0000-0000-0000-000000000000'::uuid) FROM platform.notification_campaign_events e LEFT JOIN catalog.products p ON p.active AND (p.id::text=e.reference OR p.slug=e.reference) WHERE e.recipient_id=$1 AND e.kind=$2 AND e.occurred_at>=$3 AND e.occurred_at<=$4 AND (e.kind='visit' OR p.id IS NOT NULL) AND ($5::uuid IS NULL OR p.id=$5) ORDER BY e.occurred_at DESC,e.event_id DESC LIMIT 1")
                    .bind(recipient).bind(kind).bind(from).bind(now).bind(candidate.trigger_product_id).fetch_optional(&mut *tx).await?;
                row.map(|(id,at,reference,name,product)|crate::customer_journey::Event{id:format!("inbox:{id}"),occurred_at:at,kind:kind.clone(),source:"storefront".into(),session_id:None,details:serde_json::json!({"reference":reference,"product_name":if name.is_empty(){None}else{Some(name)},"product_id":if product.is_nil(){None}else{Some(product)}})})
            } else {
                None
            };
            let owned = if let Some(customer) = customer.filter(|_| kind != "product_view") {
                crate::customer_journey::latest_event(
                    engagement,
                    commerce,
                    customer,
                    from,
                    now,
                    kind,
                    candidate.trigger_product_id,
                )
                .await?
            } else {
                None
            };
            match (browser, owned) {
                (Some(a), Some(b)) => Some(if a.occurred_at >= b.occurred_at { a } else { b }),
                (a, b) => a.or(b),
            }
        } else {
            None
        };
        let event_id = event
            .as_ref()
            .map(|e| e.id.clone())
            .unwrap_or_else(|| format!("campaign:{}", candidate.id));
        if rules.trigger_kind.is_some() && event.is_none() {
            continue;
        }
        if previous
            .as_ref()
            .is_some_and(|d| d.last_event_id.as_ref() == Some(&event_id))
        {
            continue;
        }
        if let Some(due) = event
            .as_ref()
            .map(|e| e.occurred_at + Duration::minutes(rules.delay_minutes))
            .filter(|due| *due > now)
        {
            if due < candidate.expires_at {
                due_jobs.push((candidate.id, due));
            }
            continue;
        }
        let mut facts = BTreeMap::new();
        if let Some(event) = &event {
            for (key, field) in [
                ("product.name", "product_name"),
                ("order.status", "status"),
                ("order.total", "amount"),
                ("order.currency", "currency"),
            ] {
                if let Some(value) = event.details.get(field).filter(|v| !v.is_null()) {
                    facts.insert(
                        key.into(),
                        value
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| value.to_string()),
                    );
                }
            }
            if rules.suppress_after_purchase {
                let purchased:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM orders.orders WHERE customer_id=$1 AND created_at>$2 AND created_at<=$3)")
                    .bind(customer).bind(event.occurred_at).bind(now).fetch_one(commerce).await?;
                if purchased {
                    continue;
                }
            }
        }
        if let Some(customer) = customer {
            if rules
                .conditions
                .rules
                .iter()
                .any(|r| r.field.starts_with("customer."))
            {
                let info:Option<(bool,DateTime<Utc>,i64)>=sqlx::query_as("SELECT verified,created_at,(SELECT count(*) FROM orders.orders WHERE customer_id=c.id) FROM customers.customers c WHERE id=$1")
                    .bind(customer).fetch_optional(commerce).await?;
                let Some((verified, created, count)) = info else {
                    continue;
                };
                facts.insert("customer.verified".into(), verified.to_string());
                facts.insert("customer.order_count".into(), count.to_string());
                if created <= now {
                    facts.insert(
                        "customer.account_age_days".into(),
                        (now - created).num_days().to_string(),
                    );
                }
            }
        }
        if !conditions::evaluate(&rules.conditions, &facts).matched {
            continue;
        }
        // The recipient lock serializes grants and read-state resets. New delivery
        // requires a distinct event and bounded cooldown; repeat polls are inert.
        let changed=sqlx::query("INSERT INTO platform.storefront_notification_deliveries(recipient_id,publication_id,delivered_at,delivery_count,last_event_id) SELECT $1,id,clock_timestamp(),1,$3 FROM platform.storefront_notification_publications WHERE id=$2 AND withdrawn_at IS NULL AND expires_at>clock_timestamp() ON CONFLICT(recipient_id,publication_id) DO UPDATE SET delivered_at=EXCLUDED.delivered_at,delivery_count=platform.storefront_notification_deliveries.delivery_count+1,last_event_id=EXCLUDED.last_event_id")
            .bind(recipient).bind(candidate.id).bind(event_id).execute(&mut *tx).await?.rows_affected();
        if changed > 0 && previous.is_some() {
            sqlx::query("DELETE FROM platform.storefront_notification_read_states WHERE recipient_id=$1 AND publication_id=$2")
                .bind(recipient).bind(candidate.id).execute(&mut *tx).await?;
        }
    }
    if schedule_jobs {
        for (campaign, due) in due_jobs {
            let key = format!(
                "campaign-due:{recipient}:{campaign}:{}:{}",
                area.map(|id| id.to_string()).unwrap_or_default(),
                due.to_rfc3339()
            );
            sqlx::query("INSERT INTO platform.engagement_jobs(id,dedupe_key,kind,payload,available_at) VALUES($1,$2,'campaign_evaluate',$3,$4) ON CONFLICT(dedupe_key) DO NOTHING")
                .bind(Uuid::new_v4()).bind(key).bind(serde_json::json!({"recipient":recipient,"area":area,"campaign":campaign})).bind(due).execute(&mut *tx).await?;
        }
        if let Some(after) = next {
            let run_id = run_id.unwrap_or_else(Uuid::new_v4);
            let key = format!("campaign-page:{recipient}:{after}:{run_id}");
            sqlx::query("INSERT INTO platform.engagement_jobs(id,dedupe_key,kind,payload) VALUES($1,$2,'campaign_evaluate',$3) ON CONFLICT(dedupe_key) DO NOTHING")
                .bind(Uuid::new_v4()).bind(key).bind(serde_json::json!({"recipient":recipient,"area":area,"after":after,"run_id":run_id})).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rules() -> AudienceRules {
        AudienceRules {
            segment_ids: vec![],
            segment_match: "any".into(),
            trigger_kind: Some("product_view".into()),
            conditions: conditions::Conditions::default(),
            delay_minutes: 0,
            lookback_days: 1,
            cooldown_hours: 0,
            max_deliveries: 1,
            suppress_after_purchase: false,
        }
    }
    #[test]
    fn campaign_rules_reject_incoherent_timing_and_private_guest_audiences() {
        let mut config = rules();
        assert!(config.validate("all", None).is_ok());
        config.delay_minutes = 1440;
        assert!(config.validate("customers", None).is_err());
        config.delay_minutes = 0;
        config.max_deliveries = 2;
        assert!(config.validate("customers", None).is_err());
        config.cooldown_hours = 1;
        assert!(config.validate("all", None).is_ok());
        config.trigger_kind = None;
        assert!(config.validate("customers", None).is_err());
        config = rules();
        config.segment_ids = vec![Uuid::new_v4()];
        assert!(config.validate("guests", None).is_err());
        assert!(config.validate("customers", None).is_ok());
        config.segment_ids.push(config.segment_ids[0]);
        assert!(config.validate("customers", None).is_err());
        config = rules();
        config.trigger_kind = Some("purchase".into());
        assert!(config.validate("all", None).is_err());
        assert!(config.validate("customers", None).is_ok());
        config.trigger_kind = Some("visit".into());
        assert!(config.validate("customers", Some(Uuid::new_v4())).is_err());
    }
}
