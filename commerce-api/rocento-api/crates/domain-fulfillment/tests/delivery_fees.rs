use domain_fulfillment::fees;
use rust_decimal::Decimal;
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrations = "../../migrations")]
async fn location_source_precedence_and_highest_fee(pool: PgPool) {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("UPDATE fulfillment.delivery_fee_settings SET amount=20 WHERE id")
        .execute(&mut *tx)
        .await
        .unwrap();
    let area = Uuid::new_v4();
    sqlx::query("INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km,is_active) VALUES($1,'Fee test',30,31,1,false)").bind(area).execute(&mut *tx).await.unwrap();
    let sources:Vec<Uuid>=sqlx::query_scalar("INSERT INTO inventory.inventory_sources(id,code,name) VALUES(gen_random_uuid(),'fee-a','A'),(gen_random_uuid(),'fee-b','B') RETURNING id").fetch_all(&mut *tx).await.unwrap();
    let geography = json!({"country_code":"EG","state_code":"C","city_id":"123"});
    assert_eq!(
        fees::resolve(&mut tx, None, None, &sources).await.unwrap(),
        Decimal::from(20)
    );
    sqlx::query("INSERT INTO fulfillment.delivery_fee_rules(id,country_code,state_code,city_id,location_name,amount) VALUES(gen_random_uuid(),'EG','C','123','City',30)").execute(&mut *tx).await.unwrap();
    assert_eq!(
        fees::resolve(&mut tx, None, Some(&geography), &sources)
            .await
            .unwrap(),
        Decimal::from(30)
    );
    sqlx::query("INSERT INTO fulfillment.delivery_fee_rules(id,area_id,location_name,amount) VALUES(gen_random_uuid(),$1,'Area',40)").bind(area).execute(&mut *tx).await.unwrap();
    assert_eq!(
        fees::resolve(&mut tx, Some(area), Some(&geography), &sources)
            .await
            .unwrap(),
        Decimal::from(40)
    );
    sqlx::query("INSERT INTO fulfillment.delivery_fee_rules(id,country_code,state_code,city_id,location_name,source_id,amount) VALUES(gen_random_uuid(),'EG','C','123','City',$1,50)").bind(sources[0]).execute(&mut *tx).await.unwrap();
    assert_eq!(
        fees::resolve(&mut tx, Some(area), Some(&geography), &sources)
            .await
            .unwrap(),
        Decimal::from(50)
    );
    sqlx::query("INSERT INTO fulfillment.delivery_fee_rules(id,area_id,location_name,source_id,amount) VALUES(gen_random_uuid(),$1,'Area',$2,0)").bind(area).bind(sources[0]).execute(&mut *tx).await.unwrap();
    assert_eq!(
        fees::resolve(&mut tx, Some(area), Some(&geography), &sources[..1])
            .await
            .unwrap(),
        Decimal::ZERO
    );
    assert_eq!(
        fees::resolve(&mut tx, Some(area), Some(&geography), &sources)
            .await
            .unwrap(),
        Decimal::from(40)
    );
    // The public fee must not be a minimum charge when all sources have free delivery.
    sqlx::query(
        "UPDATE fulfillment.delivery_fee_rules SET amount=0 WHERE area_id=$1 AND source_id IS NULL",
    )
    .bind(area)
    .execute(&mut *tx)
    .await
    .unwrap();
    assert_eq!(
        fees::resolve(&mut tx, Some(area), Some(&geography), &sources)
            .await
            .unwrap(),
        Decimal::ZERO
    );
    assert_eq!(
        fees::resolve(
            &mut tx,
            None,
            Some(&json!({"country_code":"US","state_code":"C","city_id":"123"})),
            &sources
        )
        .await
        .unwrap(),
        Decimal::from(20)
    );
    sqlx::query("DELETE FROM fulfillment.delivery_fee_rules WHERE area_id=$1")
        .bind(area)
        .execute(&mut *tx)
        .await
        .unwrap();
    assert_eq!(
        fees::resolve(&mut tx, Some(area), Some(&geography), &sources[1..])
            .await
            .unwrap(),
        Decimal::from(30)
    );
    assert_eq!(
        fees::resolve(&mut tx, None, None, &[]).await.unwrap(),
        Decimal::from(20)
    );
}
