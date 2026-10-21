//! Payment boundary. COD records an obligation; collection and refunds are manual.
use infra_auth::{Error, Result};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, Postgres, Transaction};
use uuid::Uuid;
pub type Tx<'a> = Transaction<'a, Postgres>;
#[derive(Serialize, Deserialize, FromRow)]
pub struct Payment {
    pub order_id: Uuid,
    pub method: String,
    #[serde(with = "rust_decimal::serde::str")]
    pub amount_due: Decimal,
    pub currency: String,
    pub collected_at: Option<chrono::DateTime<chrono::Utc>>,
    pub collected_by: Option<Uuid>,
}
#[derive(Serialize, Deserialize, FromRow)]
pub struct Refund {
    #[serde(default, skip_serializing_if = "entity_id_missing")]
    pub entity_id: i64,
    pub id: Uuid,
    pub order_id: Uuid,
    #[serde(with = "rust_decimal::serde::str")]
    pub amount: Decimal,
    pub reason: String,
    pub actor_id: Uuid,
    pub created_at: chrono::DateTime<chrono::Utc>,
}
pub trait PaymentProvider {
    fn create(
        &self,
        tx: &mut Tx<'_>,
        order: Uuid,
        amount: Decimal,
        currency: &str,
    ) -> impl std::future::Future<Output = Result<()>> + Send;
}
pub struct CashOnDelivery;
impl PaymentProvider for CashOnDelivery {
    async fn create(
        &self,
        tx: &mut Tx<'_>,
        order: Uuid,
        amount: Decimal,
        currency: &str,
    ) -> Result<()> {
        sqlx::query("INSERT INTO payments.payment_transactions(order_id,method,amount_due,currency) VALUES($1,'cod',$2,$3)").bind(order).bind(amount).bind(currency).execute(&mut **tx).await?;
        Ok(())
    }
}
pub async fn read(tx: &mut Tx<'_>, order: Uuid) -> Result<Payment> {
    Ok(
        sqlx::query_as("SELECT * FROM payments.payment_transactions WHERE order_id=$1")
            .bind(order)
            .fetch_one(&mut **tx)
            .await?,
    )
}
pub async fn refunds(tx: &mut Tx<'_>, order: Uuid) -> Result<Vec<Refund>> {
    Ok(
        sqlx::query_as("SELECT * FROM payments.manual_refunds WHERE order_id=$1")
            .bind(order)
            .fetch_all(&mut **tx)
            .await?,
    )
}
/// Order service must first enforce delivered -> cash_collected in the same transaction.
pub async fn collect(tx: &mut Tx<'_>, order: Uuid, actor: Uuid) -> Result<()> {
    let rows=sqlx::query("UPDATE payments.payment_transactions SET collected_at=clock_timestamp(),collected_by=$2 WHERE order_id=$1 AND collected_at IS NULL").bind(order).bind(actor).execute(&mut **tx).await?.rows_affected();
    if rows != 1 {
        return Err(Error::Conflict);
    }
    Ok(())
}
/// M4 supports one full manual refund, with no automatic inventory return.
pub async fn refund(tx: &mut Tx<'_>, order: Uuid, actor: Uuid, reason: &str) -> Result<()> {
    let p = read(tx, order).await?;
    if p.collected_at.is_none() {
        return Err(Error::Invalid(
            "Cash must be collected before recording a refund".into(),
        ));
    }
    sqlx::query("INSERT INTO payments.manual_refunds(id,order_id,amount,reason,actor_id) VALUES($1,$2,$3,$4,$5)").bind(Uuid::new_v4()).bind(order).bind(p.amount_due).bind(reason).bind(actor).execute(&mut **tx).await?;
    Ok(())
}

// Older persisted receipts may predate numeric entity identifiers.
fn entity_id_missing(value: &i64) -> bool {
    *value == 0
}
