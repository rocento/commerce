//! Real PostgreSQL catalog offer semantics and bounded candidate-query regressions.
use domain_pricing_promotions::recommendations::{for_products, rank, Offer};
use rust_decimal::Decimal;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

async fn products(pool: &PgPool, count: usize) -> Vec<Uuid> {
    let category = Uuid::new_v4();
    sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES($1,'Offers','offers')")
        .bind(category)
        .execute(pool)
        .await
        .unwrap();
    let ids: Vec<_> = (1..=count).map(|n| Uuid::from_u128(n as u128)).collect();
    sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) SELECT id,'offer-'||id,'offer-'||id,'Offer','Synthetic fixture',10,'USD','each',$2 FROM unnest($1::uuid[]) AS id").bind(&ids).bind(category).execute(pool).await.unwrap();
    ids
}
async fn rule(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO pricing_promotions.rules(id,name,scope,kind,value,min_subtotal,skus,category_ids,customer_group,priority,active) VALUES($1,'Offer','catalog','percentage',10,0,'{}','{}','all',1,true)").bind(id).execute(pool).await.unwrap();
    id
}
async fn candidates(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT COALESCE(sum(calls),0)::bigint FROM pg_stat_statements WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND query LIKE 'SELECT p.id,p.sku,p.category_id,p.price,p.currency,p.attributes FROM catalog.storefront_products p WHERE%'").fetch_one(pool).await.unwrap()
}
fn assert_offers(offers: &[Offer], ids: &[Uuid]) {
    assert_eq!(offers.iter().map(|o| o.product_id).collect::<Vec<_>>(), ids);
    for offer in offers {
        assert_eq!(offer.currency, "USD");
        assert_eq!(offer.original_price, Decimal::from(10));
        assert_eq!(offer.discounted_price, Decimal::from(9));
        assert_eq!(offer.savings, Decimal::ONE);
        assert_eq!(offer.discount_percent, Decimal::from(10));
    }
}
async fn check_boundaries(pool: PgPool, measure: bool) {
    let ids = products(&pool, 401).await;
    if measure {
        sqlx::query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements")
            .execute(&pool)
            .await
            .unwrap();
        let before = candidates(&pool).await;
        assert!(rank(&pool, None).await.unwrap().is_empty());
        assert_eq!(candidates(&pool).await, before);
    }
    rule(&pool).await;
    for (count, queries) in [
        (0, 1),
        (1, 1),
        (199, 1),
        (200, 2),
        (201, 2),
        (400, 3),
        (401, 3),
    ] {
        sqlx::query("UPDATE catalog.products SET active=(id=ANY($1))")
            .bind(&ids[..count])
            .execute(&pool)
            .await
            .unwrap();
        let before = if measure { candidates(&pool).await } else { 0 };
        assert_offers(&rank(&pool, None).await.unwrap(), &ids[..count]);
        if measure {
            assert_eq!(candidates(&pool).await - before, queries, "count={count}");
        }
        let mut selected = ids[..count].to_vec();
        selected.reverse();
        let before = if measure { candidates(&pool).await } else { 0 };
        assert_offers(
            &for_products(&pool, None, &selected).await.unwrap(),
            &ids[..count],
        );
        if measure {
            assert_eq!(
                candidates(&pool).await - before,
                if count == 0 { 0 } else { queries }
            );
        }
    }
    // Other eligible products remain active: selected reads must neither leak
    // them nor duplicate a requested identifier.
    let mut subset = ids[100..301].to_vec();
    subset.reverse();
    subset.push(ids[100]);
    assert_offers(
        &for_products(&pool, None, &subset).await.unwrap(),
        &ids[100..301],
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn page_boundaries_preserve_exact_offers(pool: PgPool) {
    check_boundaries(pool, false).await;
}

// Explicitly run on an isolated PostgreSQL instance preloading pg_stat_statements.
// Ordinary CI still exercises every semantic boundary without this extension.
#[sqlx::test(migrations = "../../migrations")]
#[ignore = "requires PostgreSQL shared_preload_libraries=pg_stat_statements"]
async fn candidate_query_budget_is_measured(pool: PgPool) {
    check_boundaries(pool, true).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn empty_policy_time_scope_customer_attributes_and_parent_remain_authoritative(pool: PgPool) {
    let ids = products(&pool, 2).await;
    assert!(rank(&pool, None).await.unwrap().is_empty());
    let id = rule(&pool).await;
    for change in [
        "active=false",
        "active=true,ends_at=now()-interval '1 hour'",
        "ends_at=NULL,starts_at=now()+interval '1 day'",
        "starts_at=NULL,scope='cart'",
    ] {
        sqlx::query(&format!(
            "UPDATE pricing_promotions.rules SET {change} WHERE id=$1"
        ))
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
        assert!(rank(&pool, None).await.unwrap().is_empty(), "{change}");
        assert!(for_products(&pool, None, &ids).await.unwrap().is_empty());
    }
    sqlx::query("UPDATE pricing_promotions.rules SET scope='catalog',customer_group='registered' WHERE id=$1").bind(id).execute(&pool).await.unwrap();
    assert!(rank(&pool, None).await.unwrap().is_empty());
    let customer = Uuid::new_v4();
    sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash,verified) VALUES($1,'offer@example.test','email','unused',false)").bind(customer).execute(&pool).await.unwrap();
    assert_offers(&rank(&pool, Some(customer)).await.unwrap(), &ids);
    sqlx::query("UPDATE customers.customers SET verified=true WHERE id=$1")
        .bind(customer)
        .execute(&pool)
        .await
        .unwrap();
    // Verified customers retain eligibility for registered-customer offers.
    assert_offers(&rank(&pool, Some(customer)).await.unwrap(), &ids);
    sqlx::query("UPDATE pricing_promotions.rules SET customer_group='verified' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    assert_offers(&rank(&pool, Some(customer)).await.unwrap(), &ids);
    sqlx::query("UPDATE customers.customers SET verified=false WHERE id=$1")
        .bind(customer)
        .execute(&pool)
        .await
        .unwrap();
    assert!(rank(&pool, Some(customer)).await.unwrap().is_empty());
    sqlx::query("UPDATE pricing_promotions.rules SET customer_group='all' WHERE id=$1")
        .bind(id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO attributes.definitions(id,entity_type,attribute_code,label,input_type,used_for_promo_rules) VALUES($1,'product','organic','Organic','text',true)").bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    sqlx::query(
        "INSERT INTO pricing_promotions.attribute_conditions(rule_id,conditions) VALUES($1,$2)",
    )
    .bind(id)
    .bind(json!({"organic":"yes"}))
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("UPDATE catalog.products SET attributes=$2 WHERE id=$1")
        .bind(ids[1])
        .bind(json!({"organic":"yes"}))
        .execute(&pool)
        .await
        .unwrap();
    assert_offers(&rank(&pool, None).await.unwrap(), &ids[1..]);
    sqlx::query("UPDATE catalog.products SET currency='EGP' WHERE id=$1")
        .bind(ids[1])
        .execute(&pool)
        .await
        .unwrap();
    let offers = rank(&pool, None).await.unwrap();
    assert_eq!(offers.len(), 1);
    assert_eq!(offers[0].currency, "EGP");
    assert_eq!(offers[0].discounted_price, Decimal::from(9));
    sqlx::query("UPDATE catalog.products SET parent_id=$2 WHERE id=$1")
        .bind(ids[1])
        .bind(ids[0])
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE catalog.products SET active=false WHERE id=$1")
        .bind(ids[0])
        .execute(&pool)
        .await
        .unwrap();
    assert!(rank(&pool, None).await.unwrap().is_empty());
}
#[sqlx::test(migrations = "../../migrations")]
async fn loaded_top_hundred_rules_remain_the_only_assessment_policy(pool: PgPool) {
    products(&pool, 1).await;
    let catalog = rule(&pool).await;
    sqlx::query("INSERT INTO pricing_promotions.rules(id,name,scope,kind,value,min_subtotal,skus,category_ids,customer_group,priority,active) SELECT gen_random_uuid(),'Cart','cart','percentage',1,0,'{}','{}','all',100,true FROM generate_series(1,100)").execute(&pool).await.unwrap();
    assert!(rank(&pool, None).await.unwrap().is_empty());
    sqlx::query("UPDATE pricing_promotions.rules SET priority=101 WHERE id=$1")
        .bind(catalog)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(rank(&pool, None).await.unwrap().len(), 1);
}
