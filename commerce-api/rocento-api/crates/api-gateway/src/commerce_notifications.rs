//! Durable commerce notifications, independent of ClickHouse and analytics workers.
#[cfg(test)]
use serde_json::json;
use uuid::Uuid;

type Failure = Box<dyn std::error::Error + Send + Sync>;

// Older binaries atomically committed this receipt with confirmation enqueueing.
// It remains read-only compatibility evidence after the consumers are separated.
pub(crate) async fn legacy_order_processed(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    event_id: Uuid,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform.consumer_receipts WHERE consumer_name='order-facts-v1' AND event_id=$1)")
        .bind(event_id).fetch_one(&mut **tx).await
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Consumer {
    Orders,
    LegacyShipments,
    ShipmentDispatches,
}

impl Consumer {
    fn durable_name(self) -> &'static str {
        match self {
            Self::Orders => "order-notifications-v1",
            Self::LegacyShipments => "shipment-notifications-v1",
            Self::ShipmentDispatches => "shipment-notifications-v2",
        }
    }

    fn subject(self) -> &'static str {
        match self {
            Self::Orders => "commerce.order.placed",
            Self::LegacyShipments => "commerce.order.shipped",
            Self::ShipmentDispatches => "commerce.shipment.dispatched",
        }
    }

    fn shipment(self) -> bool {
        self != Self::Orders
    }

    fn processes(self, event: &infra_events::EventEnvelope) -> bool {
        match self {
            Self::Orders => event.event_type == "order.placed",
            // Keep first-dispatch notifications on their original durable
            // subscription, so older workers remain safe during rolling updates.
            Self::LegacyShipments => event.event_type == "order.shipped",
            // A first dispatch writes both events atomically. Its notification
            // remains owned by v1; v2 handles subsequent shipments independently.
            Self::ShipmentDispatches => {
                event.event_type == "shipment.dispatched"
                    && event.payload["notified_via_order_event"] != true
            }
        }
    }
}

impl Consumer {
    pub async fn run(self, pool: sqlx::PgPool, url: String, mode: String) {
        loop {
            if let Err(error) = self.consume(&pool, &url, &mode).await {
                tracing::warn!(%error, consumer=self.durable_name(), "commerce notification consumer retrying");
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    }

    async fn consume(self, pool: &sqlx::PgPool, url: &str, mode: &str) -> Result<(), Failure> {
        use futures_util::StreamExt;
        let js = async_nats::jetstream::new(async_nats::connect(url).await?);
        let stream = js
            .get_or_create_stream(async_nats::jetstream::stream::Config {
                name: "COMMERCE_EVENTS".into(),
                subjects: vec!["commerce.>".into()],
                ..Default::default()
            })
            .await?;
        let consumer = stream
            .get_or_create_consumer(
                self.durable_name(),
                async_nats::jetstream::consumer::pull::Config {
                    durable_name: Some(self.durable_name().into()),
                    filter_subject: self.subject().into(),
                    // Replay retained history on first creation; legacy receipts suppress
                    // old confirmations, including jobs whose payload was already scrubbed.
                    deliver_policy: async_nats::jetstream::consumer::DeliverPolicy::All,
                    ack_policy: async_nats::jetstream::consumer::AckPolicy::Explicit,
                    max_ack_pending: 1,
                    ..Default::default()
                },
            )
            .await?;
        let mut messages = consumer.messages().await?;
        while let Some(message) = messages.next().await {
            let message = message?;
            let event: infra_events::EventEnvelope = serde_json::from_slice(&message.payload)?;
            self.process(pool, mode, &event).await?;
            message.ack().await?;
        }
        Ok(())
    }

    /// Commit the durable receipt and notification job together before broker acknowledgement.
    pub async fn process(
        self,
        pool: &sqlx::PgPool,
        mode: &str,
        event: &infra_events::EventEnvelope,
    ) -> Result<(), Failure> {
        if !self.processes(event) {
            return Ok(());
        }
        let event_id: Uuid = event.id.parse()?;
        let shipment = self.shipment();
        let mut receipt = pool.begin().await?;
        let claimed = sqlx::query("INSERT INTO platform.consumer_receipts(consumer_name,event_id) VALUES($1,$2) ON CONFLICT DO NOTHING")
        .bind(self.durable_name())
        .bind(event_id)
        .execute(&mut *receipt)
        .await?
        .rows_affected();
        if claimed == 0 {
            receipt.commit().await?;
            return Ok(());
        }
        // A committed legacy receipt proves that the old combined worker
        // already handled this confirmation, including historical console mode.
        // Never write that namespace here: new analytics must not infer that
        // a notification-only transaction also projected the ClickHouse fact.
        if self == Self::Orders && legacy_order_processed(&mut receipt, event_id).await? {
            receipt.commit().await?;
            return Ok(());
        }
        let id: Uuid = serde_json::from_value(event.payload["order_id"].clone())?;
        let detail = domain_orders::Service::detail_in(&mut receipt, id, None).await?;
        let contact = &detail.order.contact;
        let channel = if contact["primary_identifier"] == "mobile" {
            "SMS"
        } else {
            "email"
        };
        let recipient = if channel == "SMS" {
            &contact["mobile_number"]
        } else {
            &contact["email"]
        };
        let notification = infra_auth::Notification {
            identifier: recipient
                .as_str()
                .ok_or("Missing notification recipient")?
                .into(),
            purpose: if shipment { "shipment" } else { "order" }.into(),
            code: String::new(),
            mobile: channel == "SMS",
            link: if shipment {
                format!(
                    "Order #{} has shipped. Tracking reference: {}",
                    detail.order.number,
                    event.payload["tracking_reference"]
                        .as_str()
                        .unwrap_or("See your order page")
                )
            } else {
                format!(
                    "Order #{} confirmed. Total: {} {}. Payment: Cash on Delivery.",
                    detail.order.number, detail.order.total, detail.order.currency
                )
            },
        };
        let queued = crate::notifications::enqueue_commerce(
            &mut receipt,
            mode,
            event_id,
            detail.order.customer_id,
            &notification,
        )
        .await?;
        // The explicit development console adapter can repeat logs after a crash.
        if !queued && shipment {
            tracing::info!(target:"local_notifications", %channel, recipient=%recipient, order_number=detail.order.number, tracking_reference=%event.payload["tracking_reference"],"LOCAL DISPATCH NOTIFICATION — no external message sent");
        } else if !queued {
            tracing::info!(target:"local_notifications", %channel, recipient=%recipient, order_number=detail.order.number, amount=%detail.order.total,"LOCAL ORDER CONFIRMATION — Cash on Delivery; no external message sent");
        }
        receipt.commit().await?;
        Ok(())
    }
}

#[cfg(test)]
mod shipment_consumer_tests {
    use super::*;

    fn event(event_type: &str, payload: serde_json::Value) -> infra_events::EventEnvelope {
        infra_events::EventEnvelope {
            id: Uuid::new_v4().to_string(),
            event_type: event_type.into(),
            schema_version: 1,
            payload,
        }
    }

    #[test]
    fn legacy_pending_dispatches_keep_the_original_durable_subscription() {
        assert_eq!(
            Consumer::LegacyShipments.durable_name(),
            "shipment-notifications-v1"
        );
        assert_eq!(
            Consumer::LegacyShipments.subject(),
            "commerce.order.shipped"
        );
        let legacy = event(
            "order.shipped",
            json!({"order_id":Uuid::new_v4(),"tracking_reference":"LEGACY"}),
        );
        assert!(Consumer::LegacyShipments.processes(&legacy));
        assert!(!Consumer::ShipmentDispatches.processes(&legacy));
        assert!(!Consumer::Orders.processes(&legacy));
    }

    #[test]
    fn split_dispatches_notify_once_each_while_first_stays_on_the_legacy_consumer() {
        let order = Uuid::new_v4();
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let events = [
            event(
                "order.shipped",
                json!({"order_id":order,"shipment_id":first,"tracking_reference":"FIRST"}),
            ),
            event(
                "shipment.dispatched",
                json!({"order_id":order,"shipment_id":first,"tracking_reference":"FIRST","notified_via_order_event":true}),
            ),
            event(
                "shipment.dispatched",
                json!({"order_id":order,"shipment_id":second,"tracking_reference":"SECOND","notified_via_order_event":false}),
            ),
        ];
        let routed: Vec<_> = events
            .iter()
            .flat_map(|event| {
                [
                    Consumer::Orders,
                    Consumer::LegacyShipments,
                    Consumer::ShipmentDispatches,
                ]
                .into_iter()
                .filter(|consumer| consumer.processes(event))
                .map(move |consumer| (consumer, event.payload["shipment_id"].clone()))
            })
            .collect();
        assert_eq!(
            routed,
            vec![
                (Consumer::LegacyShipments, json!(first)),
                (Consumer::ShipmentDispatches, json!(second)),
            ]
        );
        assert_eq!(
            Consumer::ShipmentDispatches.durable_name(),
            "shipment-notifications-v2"
        );
        assert_eq!(
            Consumer::ShipmentDispatches.subject(),
            "commerce.shipment.dispatched"
        );
    }
}
