//! Compare isolated 1/20/200-line cart reads using PostgreSQL statement counts.
//! This example refuses production hosts and creates fixtures only in its owned DB.
use domain_cart_checkout::Service as Carts;
use domain_inventory::Service as Inventory;
use serde_json::json;
use sqlx::{postgres::PgPoolOptions, PgPool};
use std::{path::PathBuf, time::Instant};
use uuid::Uuid;

async fn statement_calls(pool: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT COALESCE(SUM(calls),0)::bigint FROM pg_stat_statements \
         WHERE dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) \
         AND strpos(query,'pg_stat_statements')=0",
    )
    .fetch_one(pool)
    .await
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<_> = std::env::args().collect();
    if arguments.len() != 3 || !["before", "after"].contains(&arguments[1].as_str()) {
        return Err("usage: cart-read-budget before|after OUTPUT.json".into());
    }
    let url = std::env::var("DATABASE_URL")?;
    // Only the exact disposable local fixture is allowed. No production writes.
    if url != "postgres://commerce:phase4-isolated-test@127.0.0.1:57434/phase4_budget" {
        return Err("DATABASE_URL must name the exact isolated Phase 4 budget database".into());
    }
    let output = PathBuf::from(&arguments[2]);
    if output.exists() {
        return Err("benchmark output already exists".into());
    }
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect(&url)
        .await?;
    infra_db::migrate(&pool).await?;
    sqlx::query("CREATE EXTENSION IF NOT EXISTS pg_stat_statements")
        .execute(&pool)
        .await?;
    let carts = Carts {
        pool: pool.clone(),
        inventory: Inventory::new(pool.clone(), 3600)?,
    };
    let fixtures: Vec<(Uuid, i32)> = if arguments[1] == "before" {
        let category = Uuid::from_u128(0x4400);
        sqlx::query("INSERT INTO catalog.categories(id,name,slug) VALUES($1,'Budget fixture','phase4-budget')")
            .bind(category).execute(&pool).await?;
        let mut products = Vec::new();
        for index in 0..200_u128 {
            let id = Uuid::from_u128(0x4500 + index);
            sqlx::query("INSERT INTO catalog.products(id,sku,slug,name,description,price,currency,unit,category_id) VALUES($1,$2,$3,$4,'Budget fixture',2.50,'USD','each',$5)")
                .bind(id).bind(format!("BUDGET-{index}")).bind(format!("phase4-budget-{index}"))
                .bind(format!("Budget product {index}")).bind(category).execute(&pool).await?;
            sqlx::query("INSERT INTO inventory.stock(product_id,on_hand) VALUES($1,1000)")
                .bind(id)
                .execute(&pool)
                .await?;
            sqlx::query("INSERT INTO inventory.source_items(source_id,product_id,quantity) VALUES($1,$2,1000)")
                .bind(Uuid::from_u128(1)).bind(id).execute(&pool).await?;
            products.push(id);
        }
        let mut entries = Vec::new();
        for count in [1_i32, 20, 200] {
            let customer = Uuid::from_u128(0x4700 + count as u128);
            sqlx::query("INSERT INTO customers.customers(id,email,primary_identifier,password_hash) VALUES($1,$2,'email','test-unused')")
                .bind(customer).bind(format!("budget-{count}@example.test")).execute(&pool).await?;
            let cart = carts.open(Some(customer), "").await?.cart.id;
            for product in &products[..count as usize] {
                sqlx::query("INSERT INTO cart_checkout.items(cart_id,product_id,sku,name,unit,price,currency,quantity) SELECT $1,id,sku,name,unit,price,currency,2 FROM catalog.products WHERE id=$2")
                    .bind(cart).bind(product).execute(&pool).await?;
                sqlx::query("INSERT INTO inventory.reservations(cart_id,product_id,quantity,expires_at) VALUES($1,$2,2,clock_timestamp()+interval '1 day')")
                    .bind(cart).bind(product).execute(&pool).await?;
            }
            entries.push((customer, count));
        }
        entries
    } else {
        [1_i32, 20, 200]
            .into_iter()
            .map(|count| (Uuid::from_u128(0x4700 + count as u128), count))
            .collect()
    };
    let mut measurements = Vec::new();
    for (customer, count) in fixtures {
        for _ in 0..2 {
            carts.read_customer(customer).await?;
        }
        let mut elapsed = Vec::new();
        let mut query_counts = Vec::new();
        for _ in 0..10 {
            let before = statement_calls(&pool).await?;
            let started = Instant::now();
            let view = carts
                .read_customer(customer)
                .await?
                .ok_or("missing fixture cart")?;
            elapsed.push(started.elapsed().as_secs_f64() * 1000.0);
            let after = statement_calls(&pool).await?;
            query_counts.push(after - before);
            assert_eq!(view.items.len(), count as usize);
            assert!(view.fully_reserved);
            assert!(view
                .items
                .iter()
                .all(|item| item.quantity == 2 && item.reserved_quantity == 2));
            assert_eq!(
                view.subtotal,
                rust_decimal::Decimal::new(i64::from(count) * 500, 2)
            );
        }
        elapsed.sort_by(f64::total_cmp);
        measurements.push(json!({
            "cart_items": count, "samples": elapsed.len(), "query_counts": query_counts,
            "p50_ms": (elapsed[4]+elapsed[5])/2.0, "p95_ms": elapsed[9],
            "timings_ms": elapsed,
        }));
    }
    let report = json!({
        "phase": arguments[1],
        "scope": "Warm isolated PostgreSQL fixture, one pool connection, debug Rust build, 10 reads per cart. Statement counts exclude pg_stat_statements queries and include transaction commands. This is not production throughput evidence.",
        "measurements": measurements,
    });
    std::fs::write(output, serde_json::to_string_pretty(&report)? + "\n")?;
    println!("{}", serde_json::to_string(&report)?);
    Ok(())
}
