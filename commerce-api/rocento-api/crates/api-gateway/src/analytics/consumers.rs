//! Bounded durable projections: batch storage writes without acknowledging lost work.
use super::Client;
use futures_util::StreamExt;
use infra_events::EventEnvelope;
use serde_json::json;
use sqlx::PgPool;
use std::{
    collections::{BTreeMap, HashSet},
    time::Duration,
};
use uuid::Uuid;

type Failure = Box<dyn std::error::Error + Send + Sync>;
const BATCH_SIZE: usize = 100;

#[cfg(test)]
#[path = "consumer_tests.rs"]
mod tests;

#[derive(Clone, Copy)]
enum Projection {
    Cart,
    Orders,
}

impl Projection {
    fn config(self) -> async_nats::jetstream::consumer::pull::Config {
        let mut config = async_nats::jetstream::consumer::pull::Config {
            ack_policy: async_nats::jetstream::consumer::AckPolicy::Explicit,
            max_ack_pending: BATCH_SIZE as i64,
            ack_wait: Duration::from_secs(120),
            ..Default::default()
        };
        match self {
            Self::Cart => {
                config.durable_name = Some("cart-analytics-v1".into());
                config.filter_subjects = vec![
                    "commerce.cart.item_added".into(),
                    "commerce.cart.item_removed".into(),
                    "commerce.inventory.reserved".into(),
                    "commerce.inventory.released".into(),
                ];
            }
            Self::Orders => {
                config.durable_name = Some("order-facts-v1".into());
                config.filter_subject = "commerce.order.placed".into();
            }
        }
        config
    }
}

impl Client {
    pub async fn consume_cart(self, pool: PgPool, url: String) {
        self.consume_projection(pool, url, Projection::Cart).await;
    }

    pub async fn consume_orders(self, pool: PgPool, url: String) {
        self.consume_projection(pool, url, Projection::Orders).await;
    }

    async fn consume_projection(self, pool: PgPool, url: String, projection: Projection) {
        loop {
            if let Err(error) = self.projection_loop(&pool, &url, projection).await {
                tracing::warn!(%error, "analytics consumer retrying");
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    }

    async fn projection_loop(
        &self,
        pool: &PgPool,
        url: &str,
        projection: Projection,
    ) -> Result<(), Failure> {
        let js = async_nats::jetstream::new(async_nats::connect(url).await?);
        let stream = js
            .get_or_create_stream(async_nats::jetstream::stream::Config {
                name: "COMMERCE_EVENTS".into(),
                subjects: vec!["commerce.>".into()],
                ..Default::default()
            })
            .await?;
        // Update in place; get_or_create_consumer would retain the old one-message limit.
        // Never delete the durable or reset its cursor/unacknowledged deliveries.
        let consumer = stream.create_consumer(projection.config()).await?;
        loop {
            let messages = read_batch(&consumer).await?;
            if messages.is_empty() {
                continue;
            }
            let apply = async {
                loop {
                    let events = messages
                        .iter()
                        .map(|m| serde_json::from_slice(&m.payload))
                        .collect::<Result<Vec<EventEnvelope>, _>>();
                    let result = match events {
                        Ok(events) => match projection {
                            Projection::Cart => self.record_cart_batch(pool, &events).await,
                            Projection::Orders => self.record_orders(pool, &events).await,
                        },
                        Err(error) => Err(error.into()),
                    };
                    match result {
                        Ok(()) => break,
                        Err(error) => {
                            tracing::warn!(%error, batch_size=messages.len(), "analytics batch retrying; deliveries retained");
                            tokio::time::sleep(Duration::from_secs(5)).await;
                        }
                    }
                }
            };
            complete_batch(&messages, apply, Duration::from_secs(30)).await?;
        }
    }

    /// Project a bounded cart batch while excluding concurrently erased carts.
    pub async fn record_cart_batch(
        &self,
        pool: &PgPool,
        events: &[EventEnvelope],
    ) -> Result<(), Failure> {
        check_size(events)?;
        if events.is_empty() {
            return Ok(());
        }
        let mut privacy = pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock_shared(88008)")
            .execute(&mut *privacy)
            .await?;
        let carts: Vec<Uuid> = events
            .iter()
            .filter_map(|e| identifier(&e.payload, "cart_id"))
            .collect();
        let erased: HashSet<Uuid> =
            sqlx::query_scalar("SELECT id FROM customers.erased_carts WHERE id=ANY($1)")
                .bind(&carts)
                .fetch_all(&mut *privacy)
                .await?
                .into_iter()
                .collect();
        let mut funnel = String::new();
        let mut added = String::new();
        for event in events {
            if identifier(&event.payload, "cart_id").is_some_and(|id| erased.contains(&id)) {
                continue;
            }
            let row = json!({"id":event.id,"cart_id":event.payload["cart_id"],
                "product_id":event.payload["product_id"],"quantity":event.payload["quantity"],
                "event_type":event.event_type,"reason":event.payload["reason"].as_str().unwrap_or("")}).to_string();
            funnel.push_str(&row);
            funnel.push('\n');
            if event.event_type == "cart.item_added" {
                added.push_str(&row);
                added.push('\n');
            }
        }
        if !funnel.is_empty() {
            self.execute("INSERT INTO checkout_funnel_events (id,cart_id,product_id,event_type,quantity,reason) FORMAT JSONEachRow", funnel).await?;
        }
        if !added.is_empty() {
            self.execute("INSERT INTO add_to_cart_events (id,cart_id,product_id,event_type,quantity,reason) FORMAT JSONEachRow", added).await?;
        }
        // The privacy barrier covers both durable writes. Partial writes replay by stable event IDs.
        privacy.commit().await?;
        Ok(())
    }

    /// Compatibility entry point for one event; notification completion remains independent.
    pub async fn record_order(&self, pool: &PgPool, event: &EventEnvelope) -> Result<(), Failure> {
        self.record_orders(pool, std::slice::from_ref(event)).await
    }

    /// Claim receipts atomically, write one ClickHouse block, then commit before acknowledgement.
    pub async fn record_orders(
        &self,
        pool: &PgPool,
        events: &[EventEnvelope],
    ) -> Result<(), Failure> {
        check_size(events)?;
        let mut orders = BTreeMap::new();
        for event in events.iter().filter(|e| e.event_type == "order.placed") {
            orders.entry(event.id.parse::<Uuid>()?).or_insert(event);
        }
        if orders.is_empty() {
            return Ok(());
        }
        let mut receipt = pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock_shared(88008)")
            .execute(&mut *receipt)
            .await?;
        let customers: Vec<Uuid> = orders
            .values()
            .filter_map(|e| identifier(&e.payload, "customer_id"))
            .collect();
        let erased: HashSet<Uuid> = sqlx::query_scalar("SELECT customer_id FROM customers.deletion_requests WHERE customer_id=ANY($1) AND commerce_erased_at IS NOT NULL")
            .bind(&customers).fetch_all(&mut *receipt).await?.into_iter().collect();
        orders.retain(|_, event| {
            !identifier(&event.payload, "customer_id").is_some_and(|id| erased.contains(&id))
        });
        let ids: Vec<Uuid> = orders.keys().copied().collect();
        // Deterministic insertion order avoids inverted receipt locks across overlapping deliveries.
        let claimed: Vec<Uuid> = sqlx::query_scalar("INSERT INTO platform.consumer_receipts(consumer_name,event_id) SELECT 'order-analytics-v2',id FROM unnest($1::uuid[]) AS pending(id) ORDER BY id ON CONFLICT DO NOTHING RETURNING event_id")
            .bind(&ids).fetch_all(&mut *receipt).await?;
        let legacy: HashSet<Uuid> = sqlx::query_scalar("SELECT event_id FROM platform.consumer_receipts WHERE consumer_name='order-facts-v1' AND event_id=ANY($1)")
            .bind(&claimed).fetch_all(&mut *receipt).await?.into_iter().collect();
        let mut body = String::new();
        for id in claimed {
            if legacy.contains(&id) {
                continue;
            }
            let event = orders[&id];
            let mut row = event.payload.clone();
            row["id"] = json!(event.id);
            body.push_str(&row.to_string());
            body.push('\n');
        }
        if !body.is_empty() {
            // A crash before receipt commit can replay; the derived table deduplicates by order_id.
            self.execute("INSERT INTO order_facts (id,order_id,customer_id,number,total,currency,item_count) FORMAT JSONEachRow", body).await?;
        }
        receipt.commit().await?;
        Ok(())
    }
}

async fn read_batch(
    consumer: &async_nats::jetstream::consumer::PullConsumer,
) -> Result<Vec<async_nats::jetstream::Message>, Failure> {
    // fetch() uses no_wait even with an expiry. batch() collects later arrivals
    // until this bounded window ends or the delivery limit is reached.
    let mut incoming = consumer
        .batch()
        .max_messages(BATCH_SIZE)
        .expires(Duration::from_millis(250))
        .messages()
        .await?;
    let mut messages = Vec::with_capacity(BATCH_SIZE);
    while let Some(message) = incoming.next().await {
        messages.push(message?);
    }
    Ok(messages)
}

fn identifier(value: &serde_json::Value, key: &str) -> Option<Uuid> {
    value.get(key)?.as_str()?.parse().ok()
}

fn check_size(events: &[EventEnvelope]) -> Result<(), Failure> {
    if events.len() > BATCH_SIZE {
        return Err("Analytics batch exceeds its bounded delivery size".into());
    }
    Ok(())
}

async fn complete_batch(
    messages: &[async_nats::jetstream::Message],
    apply: impl std::future::Future<Output = ()>,
    heartbeat_every: Duration,
) -> Result<(), Failure> {
    tokio::pin!(apply);
    let mut heartbeat = tokio::time::interval(heartbeat_every);
    loop {
        tokio::select! {
            _ = &mut apply => break,
            _ = heartbeat.tick() => {
                for message in messages { message.ack_with(async_nats::jetstream::AckKind::Progress).await?; }
            }
        }
    }
    for message in messages {
        message.double_ack().await?;
    }
    Ok(())
}
