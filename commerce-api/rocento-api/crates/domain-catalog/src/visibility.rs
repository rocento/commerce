//! Storefront publication eligibility belongs to catalog, independent of HTTP.
use crate::Service;
use infra_auth::Result;
use uuid::Uuid;

impl Service {
    /// A published product and its optional published parent must both be active.
    /// This is an eligibility filter, not an inventory or purchase authorization.
    pub async fn storefront_visible(&self, id: Uuid) -> Result<bool> {
        Ok(sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM catalog.storefront_products p WHERE p.id=$1 AND p.active AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.storefront_products parent WHERE parent.id=p.parent_id AND parent.active)))")
            .bind(id)
            .fetch_one(&self.pool)
            .await?)
    }
}
