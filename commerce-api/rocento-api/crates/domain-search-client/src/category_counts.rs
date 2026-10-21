//! Count every category using the same index and stock filters as shopper search.
use crate::{failure, stock_filter, Client, Search, SearchProvider};
use futures_util::{stream, StreamExt, TryStreamExt};
use infra_auth::{Error, Result};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

const BATCH_SIZE: usize = 100;

impl Client {
    pub async fn category_counts(
        &self,
        categories: &[Uuid],
        stock_ids: Option<Vec<Uuid>>,
    ) -> Result<BTreeMap<Uuid, u64>> {
        let categories = categories.iter().copied().collect::<BTreeSet<_>>();
        if self.remote {
            // Delegated providers expose search only; preserve their current contract.
            return stream::iter(categories)
                .map(|category| {
                    let stock_ids = stock_ids.clone();
                    async move {
                        let result = self
                            .search(Search {
                                category_id: Some(category),
                                in_stock: Some(true),
                                stock_ids,
                                ..Default::default()
                            })
                            .await?;
                        Ok((category, result.total))
                    }
                })
                .buffer_unordered(4)
                .try_collect()
                .await;
        }
        let categories = categories.into_iter().collect::<Vec<_>>();
        let stock_filter = stock_filter(true, stock_ids.as_deref());
        let mut counts = BTreeMap::new();
        for batch in categories.chunks(BATCH_SIZE) {
            let queries = batch
                .iter()
                .map(|id| {
                    json!({
                        "indexUid": "products", "q": "", "limit": 0,
                        "filter": [format!("category_ids = '{id}'"), stock_filter]
                    })
                })
                .collect::<Vec<_>>();
            let response = self
                .request(
                    reqwest::Method::POST,
                    "/multi-search",
                    json!({"queries": queries}),
                )
                .await?;
            let results = response["results"].as_array().ok_or(Error::Internal)?;
            if results.len() != batch.len() {
                return Err(failure("Incomplete category count response"));
            }
            for (id, result) in batch.iter().zip(results) {
                let count = result["estimatedTotalHits"]
                    .as_u64()
                    .ok_or(Error::Internal)?;
                counts.insert(*id, count);
            }
        }
        Ok(counts)
    }
}
