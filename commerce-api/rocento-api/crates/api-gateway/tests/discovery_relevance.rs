//! Run with scripts/m07-discovery-evals.py: real Meilisearch + disposable PostgreSQL.
mod support;

use api_gateway::{assistant, identity};
use domain_search_client::{discovery as d, SearchProvider};
use infra_auth::Security;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::{collections::BTreeMap, sync::Arc};
use uuid::Uuid;

#[sqlx::test(migrations = "../../migrations")]
async fn english_relevance_against_real_meilisearch(pool: PgPool) {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../../commerce-assistant-platform/evals/lab/m07-discovery.json"
    ))
    .unwrap();
    let identity = identity::App::new(
        pool.clone(),
        Security::new("m07-test-key-".repeat(6), "http://localhost".into(), false)
            .await
            .unwrap(),
        vec![],
    );
    let a = assistant::App {
        identity,
        tenant: Uuid::new_v4(),
        signing: Arc::new(
            jsonwebtoken::EncodingKey::from_rsa_pem(support::assistant_private_key()).unwrap(),
        ),
        verifying: Arc::new(
            jsonwebtoken::DecodingKey::from_rsa_pem(support::assistant_public_key()).unwrap(),
        ),
        client: reqwest::Client::new(),
        slots: Arc::new(tokio::sync::Semaphore::new(8)),
    };
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let client = domain_search_client::Client::new(
        std::env::var("M07_MEILI_URL").expect("Run scripts/m07-discovery-evals.py"),
        "m07-disposable-key-only".into(),
    );
    client.initialize().await.unwrap();
    let mut categories = BTreeMap::new();
    let mut ids = BTreeMap::new();
    for store in ["grocery", "jewelry"] {
        let c = catalog
            .save_category(
                None,
                domain_catalog::CategoryInput {
                    name: store.into(),
                    slug: store.into(),
                    parent_id: None,
                },
            )
            .await
            .unwrap();
        categories.insert(store, c.id);
    }
    for p in data["products"].as_array().unwrap() {
        let key = p["key"].as_str().unwrap();
        let product=catalog.save_product(None,serde_json::from_value(json!({"sku":key,"slug":key,"name":p["name"],"description":p["name"],"price":p["price"],"unit":p["unit"],"currency":"USD","category_id":categories[p["store"].as_str().unwrap()],"attributes":{},"media_ids":[],"active":true,"in_stock":true})).unwrap()).await.unwrap();
        ids.insert(key.to_string(), product.id);
        for synonym in p["synonyms"].as_array().unwrap() {
            d::save_edge(
                &pool,
                d::EdgeInput {
                    product_id: product.id,
                    relation: "synonym".into(),
                    target_product_id: None,
                    value: synonym.as_str().unwrap().into(),
                    dimensions: Default::default(),
                    source: "merchant".into(),
                    reviewed: true,
                    expires_at: chrono::Utc::now() + chrono::Duration::days(1),
                },
                Uuid::new_v4(),
            )
            .await
            .unwrap();
        }
    }
    client
        .sync_batch(
            &catalog,
            &a.identity.cart.inventory,
            &ids.values().copied().collect::<Vec<_>>(),
        )
        .await
        .unwrap();
    let delivery = a.identity.cart.inventory.delivery(None).await.unwrap();
    let mut results = Vec::new();
    for case in data["cases"].as_array().unwrap() {
        let q = case["query"].as_str().unwrap();
        let max = case["max_price"].as_str().unwrap();
        let category = categories[case["store"].as_str().unwrap()];
        let args = || api_gateway::assistant_catalog::SearchArgs {
            currency: None,
            predicates: vec![],
            exclusive_max: false,
            in_stock: false,
            excluded_product_ids: vec![],
            exclusive_min: false,
            query: q.into(),
            category_id: Some(category),
            min_price: None,
            max_price: Some(max.into()),
            attributes: Default::default(),
        };
        let baseline = client
            .search(domain_search_client::Search {
                q: Some(q.into()),
                category_id: Some(category),
                max_price: Some(max.into()),
                ..Default::default()
            })
            .await
            .unwrap();
        let baseline_ids = baseline
            .hits
            .iter()
            .take(20)
            .map(|p| p.id)
            .collect::<Vec<_>>();
        let mut hybrid_ids = baseline_ids.clone();
        hybrid_ids.extend(d::relation_candidates(&pool, q).await.unwrap());
        hybrid_ids.sort();
        hybrid_ids.dedup();
        let grades = case["grades"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (ids[k], v.as_u64().unwrap() as f64))
            .collect::<BTreeMap<_, _>>();
        let recall = |found: &[Uuid]| {
            if grades.is_empty() {
                None
            } else {
                Some(
                    grades.keys().filter(|id| found.contains(id)).count() as f64
                        / grades.len() as f64,
                )
            }
        };
        let quality = |found: &[Uuid]| {
            if grades.is_empty() {
                return None;
            }
            let dcg = |values: Vec<f64>| {
                values
                    .iter()
                    .take(5)
                    .enumerate()
                    .map(|(i, g)| (2.0_f64.powf(*g) - 1.0) / ((i + 2) as f64).log2())
                    .sum::<f64>()
            };
            let mut ideal = grades.values().copied().collect::<Vec<_>>();
            ideal.sort_by(|a, b| b.total_cmp(a));
            Some(
                dcg(found
                    .iter()
                    .map(|id| grades.get(id).copied().unwrap_or(0.0))
                    .collect())
                    / dcg(ideal),
            )
        };
        sqlx::query("UPDATE catalog.discovery_configuration SET enabled=false")
            .execute(&pool)
            .await
            .unwrap();
        let before = std::time::Instant::now();
        let (base, _) = api_gateway::assistant_catalog::search_with_ranker(
            &a,
            args(),
            &delivery,
            &client,
            &d::DeterministicRanker,
        )
        .await
        .unwrap();
        let base_ms = before.elapsed().as_secs_f64() * 1000.0;
        sqlx::query("UPDATE catalog.discovery_configuration SET enabled=true")
            .execute(&pool)
            .await
            .unwrap();
        let before = std::time::Instant::now();
        let (ranked, report) = api_gateway::assistant_catalog::search_with_ranker(
            &a,
            args(),
            &delivery,
            &client,
            &d::DeterministicRanker,
        )
        .await
        .unwrap();
        let hybrid_ms = before.elapsed().as_secs_f64() * 1000.0;
        let final_ids = ranked.iter().map(|p| p.id).collect::<Vec<_>>();
        assert!(ranked.iter().all(|p| p.category_id == category
            && p.price.parse::<sqlx::types::Decimal>().unwrap() <= max.parse().unwrap()));
        if grades.is_empty() {
            assert!(ranked.is_empty(), "price boundary case {}", case["id"]);
        }
        results.push(json!({"id":case["id"],"store":case["store"],"baseline_candidate_recall":recall(&baseline_ids),"reviewed_relation_candidate_recall":recall(&hybrid_ids),"baseline_ndcg_at_5":quality(&base.iter().map(|p|p.id).collect::<Vec<_>>()),"reviewed_relation_ndcg_at_5":quality(&final_ids),"baseline_ms":base_ms,"reviewed_relation_ms":hybrid_ms,"report":report}));
    }
    let mean = |field: &str| {
        let values = results
            .iter()
            .filter_map(|r| r[field].as_f64())
            .collect::<Vec<_>>();
        values.iter().sum::<f64>() / values.len() as f64
    };
    assert!(mean("reviewed_relation_candidate_recall") >= mean("baseline_candidate_recall"));
    assert!(mean("reviewed_relation_ndcg_at_5") >= mean("baseline_ndcg_at_5"));
    let report = json!({"schema_version":"1.0.0","language":"en","engine":"real Meilisearch v1.15; real PostgreSQL; production Rust adapters and ranker","judgment_source":data["judgment_source"],"semantic_enabled":false,"semantic_benefit":"unmeasured; activation blocked","provider_cost_micros":0,"cases":results.len(),"baseline_candidate_recall":mean("baseline_candidate_recall"),"reviewed_relation_candidate_recall":mean("reviewed_relation_candidate_recall"),"baseline_ndcg_at_5":mean("baseline_ndcg_at_5"),"reviewed_relation_ndcg_at_5":mean("reviewed_relation_ndcg_at_5"),"baseline_mean_ms":mean("baseline_ms"),"reviewed_relation_mean_ms":mean("reviewed_relation_ms"),"results":results});
    std::fs::write(
        std::env::var("M07_EVAL_REPORT").unwrap(),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
}
