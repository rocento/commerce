//! Moderated reviews and customer-owned wishlists.
use infra_auth::{Error, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, PgPool};
use uuid::Uuid;
#[derive(Clone)]
pub struct Service {
    pub pool: PgPool,
}
#[derive(Serialize, Deserialize, FromRow)]
pub struct Review {
    pub entity_id: i64,
    pub id: Uuid,
    pub product_id: Uuid,
    pub customer_id: Uuid,
    pub display_name: String,
    pub rating: i32,
    pub title: String,
    pub body: String,
    pub status: String,
    pub version: i32,
    pub moderation_reason: Option<String>,
    pub created_at: chrono::DateTime<chrono::Utc>,
    pub updated_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Serialize, FromRow)]
pub struct PublicReview {
    pub entity_id: i64,
    pub id: Uuid,
    pub display_name: String,
    pub rating: i32,
    pub title: String,
    pub body: String,
    pub created_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Input {
    pub display_name: String,
    pub rating: i32,
    pub title: String,
    pub body: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Moderation {
    pub status: String,
    pub reason: String,
    pub expected_version: i32,
}
impl Service {
    pub async fn submit(&self, customer: Uuid, product: Uuid, i: Input) -> Result<Review> {
        if !(1..=5).contains(&i.rating)
            || i.display_name.trim().is_empty()
            || i.display_name.len() > 80
            || i.title.trim().is_empty()
            || i.title.len() > 200
            || i.body.trim().is_empty()
            || i.body.len() > 4000
        {
            return Err(Error::Invalid(
                "Enter a display name, 1–5 rating, title and review (up to 4000 characters)".into(),
            ));
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(7008)")
            .execute(&mut *tx)
            .await?;
        let eligible:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM customers.customers WHERE id=$1 AND verified) AND EXISTS(SELECT 1 FROM catalog.products WHERE id=$2 AND active)").bind(customer).bind(product).fetch_one(&mut *tx).await?;
        if !eligible {
            return Err(Error::Invalid(
                "Verify your account and choose an available product".into(),
            ));
        }
        let r=sqlx::query_as("INSERT INTO reviews.reviews(id,customer_id,product_id,display_name,rating,title,body,status) VALUES($1,$2,$3,$4,$5,$6,$7,'pending') ON CONFLICT(product_id,customer_id) DO UPDATE SET display_name=$4,rating=$5,title=$6,body=$7,status='pending',moderation_reason=NULL,version=reviews.reviews.version+1,updated_at=clock_timestamp() RETURNING *").bind(Uuid::new_v4()).bind(customer).bind(product).bind(i.display_name.trim()).bind(i.rating).bind(i.title.trim()).bind(i.body.trim()).fetch_one(&mut *tx).await?;
        tx.commit().await?;
        Ok(r)
    }
    pub async fn public(&self, product: Uuid, offset: i64) -> Result<Vec<PublicReview>> {
        page(offset)?;
        Ok(sqlx::query_as("SELECT id,entity_id,display_name,rating,title,body,created_at FROM reviews.reviews WHERE product_id=$1 AND status='approved' AND EXISTS(SELECT 1 FROM catalog.products WHERE id=$1 AND active) ORDER BY created_at DESC,id LIMIT 50 OFFSET $2").bind(product).bind(offset).fetch_all(&self.pool).await?)
    }
    pub async fn own(&self, customer: Uuid, product: Uuid) -> Result<Option<Review>> {
        Ok(
            sqlx::query_as("SELECT * FROM reviews.reviews WHERE customer_id=$1 AND product_id=$2")
                .bind(customer)
                .bind(product)
                .fetch_optional(&self.pool)
                .await?,
        )
    }
    pub async fn queue(
        &self,
        status: &str,
        offset: i64,
        who: &domain_admin_iam::Identity,
    ) -> Result<Vec<Review>> {
        who.require("reviews.read")?;
        page(offset)?;
        if !["pending", "approved", "rejected"].contains(&status) {
            return Err(Error::Invalid("Invalid moderation state".into()));
        }
        Ok(sqlx::query_as("SELECT * FROM reviews.reviews WHERE status=$1 ORDER BY updated_at DESC,id LIMIT 50 OFFSET $2").bind(status).bind(offset).fetch_all(&self.pool).await?)
    }
    pub async fn moderate(
        &self,
        id: Uuid,
        i: Moderation,
        who: &domain_admin_iam::Identity,
    ) -> Result<Review> {
        who.require("reviews.moderate")?;
        if !["approved", "rejected"].contains(&i.status.as_str())
            || i.reason.trim().is_empty()
            || i.reason.len() > 300
        {
            return Err(Error::Invalid(
                "Choose approve/reject and enter a moderation reason".into(),
            ));
        }
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(7008)")
            .execute(&mut *tx)
            .await?;
        let r:Review=sqlx::query_as("UPDATE reviews.reviews SET status=$2,moderation_reason=$3,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND version=$4 RETURNING *").bind(id).bind(&i.status).bind(i.reason.trim()).bind(i.expected_version).fetch_optional(&mut *tx).await?.ok_or(Error::Conflict)?;
        domain_admin_iam::Service::audit(
            &mut tx,
            Some(who.user.id),
            "admin.review.moderated",
            id,
            json!({"status":i.status,"reason":i.reason,"version":r.version}),
        )
        .await?;
        tx.commit().await?;
        Ok(r)
    }
    pub async fn wishlist_ids(&self, customer: Uuid) -> Result<Vec<Uuid>> {
        Ok(sqlx::query_scalar("SELECT w.product_id FROM reviews.wishlist w JOIN catalog.products p ON p.id=w.product_id WHERE w.customer_id=$1 ORDER BY w.created_at DESC,w.product_id LIMIT 500").bind(customer).fetch_all(&self.pool).await?)
    }
    pub async fn wish(&self, customer: Uuid, product: Uuid, add: bool) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        self.wish_in(&mut tx, customer, product, add).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Update a wishlist inside a caller-owned transaction. This lets bounded
    /// cross-domain workflows commit the cart and wishlist changes atomically.
    pub async fn wish_in(
        &self,
        tx: &mut domain_inventory::Tx<'_>,
        customer: Uuid,
        product: Uuid,
        add: bool,
    ) -> Result<()> {
        sqlx::query("SELECT pg_advisory_xact_lock(7008)")
            .execute(&mut **tx)
            .await?;
        if add {
            let exists: bool = sqlx::query_scalar(
                "SELECT EXISTS(SELECT 1 FROM catalog.products WHERE id=$1 AND active)",
            )
            .bind(product)
            .fetch_one(&mut **tx)
            .await?;
            if !exists {
                return Err(Error::NotFound);
            }
            let count: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM reviews.wishlist WHERE customer_id=$1 AND product_id<>$2",
            )
            .bind(customer)
            .bind(product)
            .fetch_one(&mut **tx)
            .await?;
            if count >= 500 {
                return Err(Error::Invalid("Wishlist limit is 500 products".into()));
            }
            sqlx::query("INSERT INTO reviews.wishlist(customer_id,product_id) VALUES($1,$2) ON CONFLICT DO NOTHING").bind(customer).bind(product).execute(&mut **tx).await?;
        } else {
            sqlx::query("DELETE FROM reviews.wishlist WHERE customer_id=$1 AND product_id=$2")
                .bind(customer)
                .bind(product)
                .execute(&mut **tx)
                .await?;
        }
        Ok(())
    }
}
fn page(offset: i64) -> Result<()> {
    if !(0..=1000000).contains(&offset) {
        return Err(Error::Invalid("Invalid offset".into()));
    }
    Ok(())
}
