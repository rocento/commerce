//! Integration tests use sqlx-created isolated databases, never a live merchant catalog.
mod support;
use domain_attributes::{industry, metadata::Metadata, Definition, Service};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;
fn definition(code: &str, kind: &str) -> Definition {
    serde_json::from_value(json!({"id":Uuid::new_v4(),"entity_type":"product","attribute_code":code,"label":code,"input_type":kind,"scope":"global","is_required":false,"is_unique":false,"is_searchable":true,"is_filterable":true,"is_comparable":true,"is_visible_on_front":true,"used_for_promo_rules":false,"used_for_configurations":false,"swatch_type":"none","options":[],"version":0,"metadata":{"ai_queryable":true}})).unwrap()
}
async fn product(
    pool: &PgPool,
    code: &str,
    values: serde_json::Value,
    set: Option<Uuid>,
) -> domain_catalog::Product {
    let catalog = domain_catalog::Service { pool: pool.clone() };
    let category = catalog
        .save_category(
            None,
            serde_json::from_value(json!({"name":code,"slug":code,"parent_id":null})).unwrap(),
        )
        .await
        .unwrap();
    catalog.save_product(None,serde_json::from_value(json!({"sku":code,"slug":code,"name":code,"description":"test","price":"10.00","currency":"USD","unit":"each","category_id":category.id,"attributes":values,"attribute_set_id":set,"media_ids":[],"active":true,"in_stock":true})).unwrap()).await.unwrap()
}
fn apply(profile: &industry::IndustryProfile, version: i32) -> industry::Apply {
    industry::Apply {
        profile_id: profile.id,
        profile_version: profile.version,
        expected_version: version,
        selected_codes: profile
            .template
            .iter()
            .map(|m| m.definition.attribute_code.clone())
            .collect(),
        confirmed: true,
    }
}

async fn enrichment_fixture(pool: &PgPool) -> (Service, domain_catalog::Product, Definition, Uuid) {
    let service = Service { pool: pool.clone() };
    let mut style = definition("style", "single_select");
    style.options =
        json!([{"value":"casual","label":"Casual"},{"value":"formal","label":"Formal"}]);
    style.metadata.source_policy = "semantic".into();
    style.metadata.ai_enrichable = true;
    let style = service.save(style).await.unwrap();
    let p = product(pool, "enrichment-product", json!({}), None).await;
    sqlx::query("UPDATE catalog.products SET description='Style: Casual' WHERE id=$1")
        .bind(p.id)
        .execute(pool)
        .await
        .unwrap();
    let actor = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'enrichment@test.local','Reviewer','unused',$2)")
        .bind(actor).bind(domain_admin_iam::SUPER).execute(pool).await.unwrap();
    (service, p, style, actor)
}

#[sqlx::test(migrations = "../../migrations")]
async fn enrichment_generation_is_grounded_idempotent_and_audited(pool: PgPool) {
    use domain_attributes::enrichment::Review;
    let (service, p, _, actor) = enrichment_fixture(&pool).await;
    let first = service.generate_enrichment(p.id).await.unwrap();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0].value, json!("casual"));
    assert_eq!(first[0].source, "DERIVED");
    assert_eq!(first[0].evidence.as_ref().unwrap().quote, "Style: Casual");
    assert!(service.value_records(p.id).await.unwrap().is_empty());
    let repeated = service.generate_enrichment(p.id).await.unwrap();
    assert_eq!(first[0].id, repeated[0].id);
    let (a, b) = tokio::join!(
        service.review_suggestion(first[0].id, Review { approve: true }, actor),
        service.review_suggestion(first[0].id, Review { approve: true }, actor)
    );
    assert_eq!(usize::from(a.is_ok()) + usize::from(b.is_ok()), 1);
    let records = service.value_records(p.id).await.unwrap();
    assert_eq!(records[0].value, json!("casual"));
    assert_eq!(records[0].source, "DERIVED");
    assert!(service.generate_enrichment(p.id).await.unwrap().is_empty());
    let count:i64=sqlx::query_scalar("SELECT count(*) FROM admin_iam.audit_log WHERE action='catalog.enrichment_approved' AND entity_id=$1").bind(first[0].id).fetch_one(&pool).await.unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn enrichment_sibling_approvals_preserve_independent_snapshots(pool: PgPool) {
    use domain_attributes::enrichment::Review;
    let (service, p, _, actor) = enrichment_fixture(&pool).await;
    let mut occasion = definition("occasion", "text");
    occasion.metadata.source_policy = "semantic".into();
    occasion.metadata.ai_enrichable = true;
    service.save(occasion).await.unwrap();
    sqlx::query(
        "UPDATE catalog.products SET description='Style: Casual\noccasion: Weekend' WHERE id=$1",
    )
    .bind(p.id)
    .execute(&pool)
    .await
    .unwrap();
    let suggestions = service.generate_enrichment(p.id).await.unwrap();
    assert_eq!(suggestions.len(), 2);
    for suggestion in suggestions {
        service
            .review_suggestion(suggestion.id, Review { approve: true }, actor)
            .await
            .unwrap();
    }
    assert_eq!(service.value_records(p.id).await.unwrap().len(), 2);
}

#[sqlx::test(migrations = "../../migrations")]
async fn enrichment_rejects_stale_source_values_and_definitions(pool: PgPool) {
    use domain_attributes::enrichment::Review;
    let (service, p, mut definition, actor) = enrichment_fixture(&pool).await;
    let old = service.generate_enrichment(p.id).await.unwrap().remove(0);
    sqlx::query("UPDATE catalog.products SET description='Style: Formal' WHERE id=$1")
        .bind(p.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(service
        .review_suggestion(old.id, Review { approve: true }, actor)
        .await
        .is_err());
    assert!(service.value_records(p.id).await.unwrap().is_empty());
    let fresh = service.generate_enrichment(p.id).await.unwrap().remove(0);
    assert_ne!(fresh.id, old.id);
    definition.metadata.description = "Revised interpretation".into();
    service.save(definition).await.unwrap();
    assert!(service
        .review_suggestion(fresh.id, Review { approve: true }, actor)
        .await
        .is_err());
    let latest = service.generate_enrichment(p.id).await.unwrap().remove(0);
    sqlx::query("UPDATE catalog.products SET attributes='{\"style\":\"casual\"}' WHERE id=$1")
        .bind(p.id)
        .execute(&pool)
        .await
        .unwrap();
    assert!(service
        .review_suggestion(latest.id, Review { approve: true }, actor)
        .await
        .is_err());
    assert_eq!(
        service.value_records(p.id).await.unwrap()[0].value,
        json!("casual")
    );
    // Stale proposals remain rejectable and never report a successful approval.
    assert_eq!(
        service
            .review_suggestion(old.id, Review { approve: false }, actor)
            .await
            .unwrap()
            .status,
        "rejected"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn enrichment_rejection_is_not_regenerated_and_invalid_evidence_is_rejected(pool: PgPool) {
    use domain_attributes::enrichment::{Evidence, Review, SuggestionInput};
    let (service, p, d, actor) = enrichment_fixture(&pool).await;
    let suggestion = service.generate_enrichment(p.id).await.unwrap().remove(0);
    service
        .review_suggestion(suggestion.id, Review { approve: false }, actor)
        .await
        .unwrap();
    let again = service.generate_enrichment(p.id).await.unwrap().remove(0);
    assert_eq!(again.id, suggestion.id);
    assert_eq!(again.status, "rejected");
    assert!(service.value_records(p.id).await.unwrap().is_empty());
    for evidence in [
        Evidence {
            field: "description".into(),
            quote: "invented evidence".into(),
        },
        Evidence {
            field: "remote_url".into(),
            quote: "Style: Casual".into(),
        },
    ] {
        assert!(service
            .propose(SuggestionInput {
                product_id: p.id,
                definition_id: d.id,
                value: json!("formal"),
                source: "AI_INFERRED".into(),
                confidence: 0.9,
                model_version: "test".into(),
                evidence
            })
            .await
            .is_err());
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn enrichment_page_filters_before_limiting_and_reaches_older_rows(pool: PgPool) {
    use domain_attributes::enrichment::SuggestionQuery;
    let (service, p, d, _) = enrichment_fixture(&pool).await;
    // Historical records without evidence can be browsed but must not be approved.
    sqlx::query("INSERT INTO attributes.enrichment_suggestions(id,product_id,definition_id,value,source,confidence,model_version,status,created_at) SELECT gen_random_uuid(),$1,$2,'\"casual\"','DERIVED',1,'legacy',CASE WHEN n<=205 THEN 'pending' ELSE 'rejected' END,now()+n*interval '1 second' FROM generate_series(1,210) n")
        .bind(p.id).bind(d.id).execute(&pool).await.unwrap();
    let mut seen = std::collections::HashSet::new();
    let mut before = None;
    loop {
        let page = service
            .suggestion_page(SuggestionQuery {
                status: Some("pending".into()),
                before,
                limit: Some(50),
                product_id: Some(p.id),
            })
            .await
            .unwrap();
        for row in &page {
            assert_eq!(row.status, "pending");
            assert!(seen.insert(row.id));
        }
        if page.len() < 50 {
            break;
        }
        before = page.last().map(|r| r.id);
    }
    assert_eq!(seen.len(), 205);
    assert!(service
        .suggestion_page(SuggestionQuery {
            limit: Some(101),
            ..Default::default()
        })
        .await
        .is_err());
    assert!(service
        .suggestion_page(SuggestionQuery {
            status: Some("invented".into()),
            ..Default::default()
        })
        .await
        .is_err());
}

#[sqlx::test(migrations = "../../migrations")]
async fn enrichment_http_permissions_csrf_and_contract_are_enforced(pool: PgPool) {
    use axum::{body::Body, http::Request};
    use http_body_util::BodyExt;
    use tower::ServiceExt;
    let (_, p, _, actor) = enrichment_fixture(&pool).await;
    let security = infra_auth::Security::new(
        "test-secret-at-least-32-characters-long".into(),
        "http://localhost:5173".into(),
        false,
    )
    .await
    .unwrap();
    let app = api_gateway::identity::App::new(
        pool.clone(),
        security,
        vec!["http://localhost:5173".into()],
    );
    let router = api_gateway::attributes::router(app);
    let role = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.roles(id,name,permissions) VALUES($1,'enrichment-reviewer',ARRAY['attributes.read'])").bind(role).execute(&pool).await.unwrap();
    sqlx::query("UPDATE admin_iam.admin_users SET role_id=$1 WHERE id=$2")
        .bind(role)
        .bind(actor)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO admin_iam.sessions(token_hash,admin_id,expires_at) VALUES($1,$2,now()+interval '1 hour')").bind(infra_auth::digest("enrichment-session")).bind(actor).execute(&pool).await.unwrap();
    let uri = "/v1/admin/catalog/enrichment";
    assert_eq!(
        router
            .clone()
            .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status(),
        401
    );
    assert_eq!(
        router
            .clone()
            .oneshot(
                Request::builder()
                    .uri(uri)
                    .header("cookie", "admin_session=enrichment-session")
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        403
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['attributes.read','catalog.read'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    let generate = format!("/v1/admin/catalog/products/{}/enrichment", p.id);
    let request = || {
        Request::builder()
            .method("POST")
            .uri(&generate)
            .header("cookie", "admin_session=enrichment-session")
            .header("x-commerce-request", "1")
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        router.clone().oneshot(request()).await.unwrap().status(),
        403
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['attributes.read','attributes.write','catalog.read'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    assert_eq!(
        router
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(&generate)
                    .header("cookie", "admin_session=enrichment-session")
                    .body(Body::empty())
                    .unwrap()
            )
            .await
            .unwrap()
            .status(),
        403
    );
    let response = router.clone().oneshot(request()).await.unwrap();
    assert_eq!(response.status(), 200);
    let rows: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../../openapi.json")).unwrap();
    support::validate_shape(
        &rows[0],
        &contract["components"]["schemas"]["EnrichmentSuggestion"],
        &contract,
    );
    assert!(rows[0].get("basis").is_none());
    let review = format!(
        "/v1/admin/catalog/enrichment/{}",
        rows[0]["id"].as_str().unwrap()
    );
    let review_request = || {
        Request::builder()
            .method("PUT")
            .uri(&review)
            .header("cookie", "admin_session=enrichment-session")
            .header("x-commerce-request", "1")
            .header("content-type", "application/json")
            .body(Body::from(r#"{"approve":true}"#))
            .unwrap()
    };
    assert_eq!(
        router
            .clone()
            .oneshot(review_request())
            .await
            .unwrap()
            .status(),
        403
    );
    sqlx::query("UPDATE admin_iam.roles SET permissions=ARRAY['attributes.read','attributes.write','catalog.read','catalog.write'] WHERE id=$1").bind(role).execute(&pool).await.unwrap();
    assert_eq!(
        router.oneshot(review_request()).await.unwrap().status(),
        200
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn industry_preview_application_is_explicit_atomic_and_idempotent(pool: PgPool) {
    let service = Service { pool: pool.clone() };
    let profile = industry::templates()
        .into_iter()
        .find(|p| p.code == "jewelry")
        .unwrap();
    let definitions_before = service.list("product").await.unwrap();
    let sets_before = service.sets().await.unwrap().len();
    let preview = service.preview_industry(profile.id).await.unwrap();
    assert_eq!(preview.attributes.len(), 15);
    assert_eq!(
        json!(service.list("product").await.unwrap()),
        json!(definitions_before)
    );
    let mut input = apply(&profile, 0);
    input.confirmed = false;
    assert!(service.apply_industry(input).await.is_err());
    let config = service.apply_industry(apply(&profile, 0)).await.unwrap();
    assert_eq!(config.version, 1);
    let again = service.apply_industry(apply(&profile, 1)).await.unwrap();
    assert_eq!(again.version, 1);
    assert_eq!(service.sets().await.unwrap().len(), sets_before + 1);
    assert!(service.apply_industry(apply(&profile, 0)).await.is_err());
    let schema = service.catalog_schema(true).await.unwrap();
    assert_eq!(schema.industry.as_deref(), Some("jewelry"));
    assert!(schema
        .attributes
        .iter()
        .any(|a| a.code == "gemstone_color" && a.options.iter().any(|o| o.code == "red")));
    assert!(service.save_profile(profile.clone()).await.is_err());
    let mut custom = profile;
    custom.id = Uuid::new_v4();
    custom.code = "merchant_diamonds".into();
    custom.name = "Merchant diamonds".into();
    custom.version = 0;
    let custom = service.save_profile(custom).await.unwrap();
    assert_eq!(custom.version, 1);
    assert_eq!(
        industry::templates()
            .iter()
            .filter(|p| p.code == "jewelry")
            .count(),
        1
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn profile_conflicts_preserve_merchant_data_and_theme_independence(pool: PgPool) {
    let service = Service { pool: pool.clone() };
    service.save(definition("metal", "integer")).await.unwrap();
    let definitions_before = service.list("product").await.unwrap();
    let profile = industry::templates()
        .into_iter()
        .find(|p| p.code == "jewelry")
        .unwrap();
    let preview = service.preview_industry(profile.id).await.unwrap();
    assert!(preview
        .attributes
        .iter()
        .any(|a| a.code == "metal" && a.action == "conflict"));
    assert!(service.apply_industry(apply(&profile, 0)).await.is_err());
    assert_eq!(
        json!(service.list("product").await.unwrap()),
        json!(definitions_before)
    );
    assert_eq!(service.configuration().await.unwrap().version, 0);
    let before_themes: serde_json::Value =
        sqlx::query_scalar("SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]') FROM theme.themes t")
            .fetch_one(&pool)
            .await
            .unwrap();
    let other = industry::templates()
        .into_iter()
        .find(|p| p.code == "general")
        .unwrap();
    service.apply_industry(apply(&other, 0)).await.unwrap();
    let after_themes: serde_json::Value =
        sqlx::query_scalar("SELECT COALESCE(jsonb_agg(to_jsonb(t)),'[]') FROM theme.themes t")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(before_themes, after_themes);
    assert_eq!(
        service
            .list("product")
            .await
            .unwrap()
            .into_iter()
            .find(|d| d.attribute_code == "metal")
            .unwrap()
            .input_type,
        "integer"
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn types_bounds_defaults_and_schema_visibility_are_validated(pool: PgPool) {
    let service = Service { pool: pool.clone() };
    for (kind, valid, invalid) in [
        ("integer", json!(3), json!(3.5)),
        ("decimal", json!(1.2), json!("1.2")),
        ("boolean", json!(true), json!("true")),
        ("date", json!("2026-09-15"), json!("2026-02-30")),
        (
            "datetime",
            json!("2026-09-15T10:00:00Z"),
            json!("yesterday"),
        ),
        ("long_text", json!("description"), json!(false)),
        ("measurement", json!(1.2), json!("1.2ct")),
    ] {
        let mut d = definition(kind, kind);
        if kind == "measurement" {
            d.metadata.unit = Some("ct".into());
            d.metadata.min = Some(0.0);
        }
        let d = service.save(d).await.unwrap();
        assert!(domain_attributes::validate_value(&d, &valid).is_ok());
        assert!(domain_attributes::validate_value(&d, &invalid).is_err());
    }
    let mut defaulted = definition("defaulted", "integer");
    defaulted.metadata.default_value = Some(json!(7));
    service.save(defaulted).await.unwrap();
    let created = product(&pool, "with-default", json!({}), None).await;
    assert_eq!(created.attributes["defaulted"], json!(7));
    let supplied = product(&pool, "with-explicit-value", json!({"defaulted":9}), None).await;
    assert_eq!(supplied.attributes["defaulted"], json!(9));
    let mut hidden = definition("hidden", "text");
    hidden.is_visible_on_front = false;
    service.save(hidden).await.unwrap();
    let mut disabled = definition("disabled", "text");
    disabled.metadata.status = "disabled".into();
    service.save(disabled).await.unwrap();
    let schema = service.catalog_schema(true).await.unwrap();
    assert!(!schema
        .attributes
        .iter()
        .any(|a| ["hidden", "disabled"].contains(&a.code.as_str())));
    let mut bad = definition("invalid_default", "integer");
    bad.metadata.default_value = Some(json!("oops"));
    assert!(service.save(bad).await.is_err());
    let mut bad = definition("unsafe", "text");
    bad.metadata.ai_enrichable = true;
    assert!(service.save(bad).await.is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn required_set_rules_and_destructive_set_changes_are_guarded(pool: PgPool) {
    let service = Service { pool: pool.clone() };
    let d = service.save(definition("material", "text")).await.unwrap();
    let set = service
        .save_set(domain_attributes::AttributeSet {
            id: Uuid::new_v4(),
            entity_id: 0,
            name: "First".into(),
            description: "".into(),
            version: 0,
            members: vec![domain_attributes::SetMember {
                definition_id: d.id,
                group_name: "Material".into(),
                position: 0,
            }],
        })
        .await
        .unwrap();
    let p = product(&pool, "ring", json!({"material":"gold"}), Some(set.id)).await;
    assert!(service.delete_set(set.id).await.is_err());
    let mut changed = set.clone();
    changed.members.clear();
    assert!(service.save_set(changed).await.is_err());
    let other = service
        .save_set(domain_attributes::AttributeSet {
            id: Uuid::new_v4(),
            entity_id: 0,
            name: "Other".into(),
            description: "".into(),
            version: 0,
            members: vec![],
        })
        .await
        .unwrap();
    product(&pool, "other", json!({}), Some(other.id)).await;
    let mut required = d.clone();
    required.is_required = true;
    service.save(required).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    assert!(
        domain_attributes::validate_product(&mut tx, p.id, &json!({}), Some(set.id))
            .await
            .is_err()
    );
    assert!(
        domain_attributes::validate_product(&mut tx, p.id, &json!({}), Some(other.id))
            .await
            .is_ok()
    );
}
#[sqlx::test(migrations = "../../migrations")]
async fn enrichment_cannot_infer_medical_facts_or_overwrite_authoritative_values(pool: PgPool) {
    let service = Service { pool: pool.clone() };
    let pharmacy = industry::templates()
        .into_iter()
        .find(|p| p.code == "pharmacy")
        .unwrap();
    let config = service.apply_industry(apply(&pharmacy, 0)).await.unwrap();
    let p = product(
        &pool,
        "medicine",
        json!({"active_ingredient":"merchant fact"}),
        config.default_attribute_set_id,
    )
    .await;
    let ingredient = service
        .list("product")
        .await
        .unwrap()
        .into_iter()
        .find(|d| d.attribute_code == "active_ingredient")
        .unwrap();
    let proposal =
        |product_id, definition_id, value| domain_attributes::enrichment::SuggestionInput {
            product_id,
            definition_id,
            value,
            source: "AI_INFERRED".into(),
            confidence: 0.93,
            model_version: "test-model-v1".into(),
            evidence: domain_attributes::enrichment::Evidence {
                field: "description".into(),
                quote: "test".into(),
            },
        };
    assert!(service
        .propose(proposal(p.id, ingredient.id, json!("invented")))
        .await
        .is_err());
    let mut weakened = ingredient;
    weakened.metadata.source_policy = "semantic".into();
    weakened.metadata.ai_enrichable = true;
    assert!(service.save(weakened).await.is_err());
    let mut style = definition("style", "text");
    style.metadata = sqlx::types::Json(Metadata {
        source_policy: "semantic".into(),
        ai_enrichable: true,
        ..Metadata::default()
    });
    let style = service.save(style).await.unwrap();
    let authoritative = product(&pool, "auth", json!({"style":"classic"}), None).await;
    let suggestion = service
        .propose(proposal(authoritative.id, style.id, json!("luxury")))
        .await
        .unwrap();
    assert_eq!(
        service.value_records(authoritative.id).await.unwrap()[0].source,
        "MERCHANT"
    );
    let actor = Uuid::new_v4();
    sqlx::query("INSERT INTO admin_iam.admin_users(id,email,name,password_hash,role_id) VALUES($1,'reviewer@test.local','Reviewer','unused',$2)").bind(actor).bind(domain_admin_iam::SUPER).execute(&pool).await.unwrap();
    assert!(service
        .review_suggestion(
            suggestion.id,
            domain_attributes::enrichment::Review { approve: true },
            actor
        )
        .await
        .is_err());
    let blank = product(&pool, "blank", json!({}), None).await;
    let suggested = service
        .propose(proposal(blank.id, style.id, json!("luxury")))
        .await
        .unwrap();
    service
        .review_suggestion(
            suggested.id,
            domain_attributes::enrichment::Review { approve: true },
            actor,
        )
        .await
        .unwrap();
    let records = service.value_records(blank.id).await.unwrap();
    assert_eq!(records[0].source, "AI_INFERRED");
    assert_eq!(records[0].value, json!("luxury"));
    assert!(service
        .review_suggestion(
            suggested.id,
            domain_attributes::enrichment::Review { approve: true },
            actor
        )
        .await
        .is_err());
}
#[sqlx::test(migrations = "../../migrations")]
async fn managed_options_relationships_and_filters_are_closed(pool: PgPool) {
    let service = Service { pool: pool.clone() };
    let mut color = definition("color", "single_select");
    color.options = json!([{"value":"red","label":"Red","labels":{"ar":"أحمر"}}]);
    let color = service.save(color).await.unwrap();
    let defs = service.list("product").await.unwrap();
    assert!(domain_attributes::schema::validate_filters(
        &defs,
        &std::collections::BTreeMap::from([("color".into(), json!("red"))]),
        true
    )
    .is_ok());
    for (code, value) in [
        ("unknown", json!("red")),
        ("color", json!("blue")),
        ("color", json!({"$where":"unsafe"})),
    ] {
        assert!(domain_attributes::schema::validate_filters(
            &defs,
            &std::collections::BTreeMap::from([(code.into(), value)]),
            true
        )
        .is_err());
    }
    product(&pool, "red-product", json!({"color":"red"}), None).await;
    let mut invalid = color.clone();
    invalid.options = json!([{"value":"blue","label":"Blue"}]);
    assert!(service.save(invalid).await.is_err());
    assert!(service.delete(color.id).await.is_err());
}

async fn check_new_client_package(pool: PgPool, code: &str) {
    let service = Service { pool: pool.clone() };
    let profile = industry::templates()
        .into_iter()
        .find(|p| p.code == code)
        .unwrap();
    let definitions_before = service.list("product").await.unwrap();
    let configuration = service.onboard_industry(profile.id, 0).await.unwrap();
    assert_eq!(configuration.industry_profile_id, Some(profile.id));
    let set_id = configuration.default_attribute_set_id.unwrap();
    let sets = service.sets().await.unwrap();
    let set = sets.iter().find(|s| s.id == set_id).unwrap();
    assert_eq!(set.members.len(), profile.template.len());
    let definitions = service.list("product").await.unwrap();
    let expected_codes: std::collections::BTreeSet<_> = definitions_before
        .iter()
        .map(|d| d.attribute_code.as_str())
        .chain(
            profile
                .template
                .iter()
                .map(|entry| entry.definition.attribute_code.as_str()),
        )
        .collect();
    assert_eq!(
        definitions
            .iter()
            .map(|d| d.attribute_code.as_str())
            .collect::<std::collections::BTreeSet<_>>(),
        expected_codes
    );
    for existing in &definitions_before {
        let mut expected = existing.clone();
        if code == "grocery" && existing.attribute_code == "weight" {
            expected.metadata.unit = Some("g".into());
            expected.label = "Weight".into();
            expected.version += 1;
        } else if code == "pharmacy" && existing.attribute_code == "manufacturer" {
            expected.metadata.source_policy = "trusted_only".into();
            expected.version += 1;
        }
        assert_eq!(
            json!(definitions.iter().find(|d| d.id == existing.id).unwrap()),
            json!(expected)
        );
    }
    for expected in &profile.template {
        let actual = definitions
            .iter()
            .find(|d| d.attribute_code == expected.definition.attribute_code)
            .unwrap();
        assert_eq!(actual.options, expected.definition.options);
        assert_eq!(
            actual.metadata.source_policy,
            expected.definition.metadata.source_policy
        );
        assert!(set
            .members
            .iter()
            .any(|m| m.definition_id == actual.id && m.group_name == expected.group));
    }
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM inventory.inventory_sources WHERE code='default'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM inventory.sales_channel_stock_links WHERE channel_id='storefront'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM catalog.products")
            .fetch_one(&pool)
            .await
            .unwrap(),
        0
    );
    // A subsequent provisioning run is not a template upgrade/reset operation.
    if let Some(first) = definitions.first() {
        let mut customized = first.clone();
        customized.label = "Merchant customized label".into();
        customized.metadata.status = "disabled".into();
        service.save(customized).await.unwrap();
    }
    let repeated = service
        .onboard_industry(profile.id, configuration.version)
        .await
        .unwrap();
    assert_eq!(repeated.version, configuration.version);
    if !definitions.is_empty() {
        assert!(service
            .list("product")
            .await
            .unwrap()
            .iter()
            .any(|d| d.label == "Merchant customized label" && !d.metadata.active()));
    }
    let other = industry::templates()
        .into_iter()
        .find(|p| p.id != profile.id)
        .unwrap();
    assert!(service
        .onboard_industry(other.id, configuration.version)
        .await
        .is_err());
}

macro_rules! onboarding_test {
    ($name:ident, $code:literal) => {
        #[sqlx::test(migrations = "../../migrations")]
        async fn $name(pool: PgPool) {
            check_new_client_package(pool, $code).await;
        }
    };
}
onboarding_test!(onboard_general, "general");
onboarding_test!(onboard_fashion, "fashion");
onboarding_test!(onboard_jewelry, "jewelry");
onboarding_test!(onboard_skincare, "skincare");
onboarding_test!(onboard_pharmacy, "pharmacy");
onboarding_test!(onboard_electronics, "electronics");
onboarding_test!(onboard_beauty, "beauty");
onboarding_test!(onboard_grocery, "grocery");
onboarding_test!(onboard_home, "home");

#[sqlx::test(migrations = "../../migrations")]
async fn onboarding_preserves_edited_defaults_and_rolls_back_other_changes(pool: PgPool) {
    let service = Service { pool: pool.clone() };
    let profile = industry::templates()
        .into_iter()
        .find(|p| p.code == "grocery")
        .unwrap();
    let mut weight = service
        .list("product")
        .await
        .unwrap()
        .into_iter()
        .find(|d| d.attribute_code == "weight")
        .unwrap();
    weight.label = "Merchant kilograms".into();
    let edited = service.save(weight).await.unwrap();
    let before = json!(service.list("product").await.unwrap());
    let preview = service.preview_industry(profile.id).await.unwrap();
    assert_eq!(
        preview
            .attributes
            .iter()
            .find(|a| a.code == "weight")
            .unwrap()
            .action,
        "conflict"
    );
    assert!(service.onboard_industry(profile.id, 0).await.is_err());
    assert_eq!(json!(service.list("product").await.unwrap()), before);
    assert_eq!(service.configuration().await.unwrap().version, 0);
    assert_eq!(edited.metadata.unit.as_deref(), Some("kg"));
}

#[sqlx::test(migrations = "../../migrations")]
async fn onboarding_never_reinterprets_existing_product_units(pool: PgPool) {
    let service = Service { pool: pool.clone() };
    let profile = industry::templates()
        .into_iter()
        .find(|p| p.code == "grocery")
        .unwrap();
    let p = product(&pool, "existing-weight", json!({"weight":2}), None).await;
    let before = json!(service.list("product").await.unwrap());
    assert!(service.onboard_industry(profile.id, 0).await.is_err());
    assert_eq!(json!(service.list("product").await.unwrap()), before);
    let value: serde_json::Value =
        sqlx::query_scalar("SELECT attributes FROM catalog.products WHERE id=$1")
            .bind(p.id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(value, json!({"weight":2}));
}

#[sqlx::test(migrations = "../../migrations")]
async fn onboarding_previews_pristine_default_configuration_without_mutating(pool: PgPool) {
    let service = Service { pool: pool.clone() };
    let profile = industry::templates()
        .into_iter()
        .find(|p| p.code == "pharmacy")
        .unwrap();
    let before = json!(service.list("product").await.unwrap());
    let preview = service.preview_industry(profile.id).await.unwrap();
    assert_eq!(
        preview
            .attributes
            .iter()
            .find(|a| a.code == "manufacturer")
            .unwrap()
            .action,
        "configure_default"
    );
    assert_eq!(json!(service.list("product").await.unwrap()), before);
    let applied = service.onboard_industry(profile.id, 0).await.unwrap();
    let after = json!(service.list("product").await.unwrap());
    service
        .onboard_industry(profile.id, applied.version)
        .await
        .unwrap();
    assert_eq!(json!(service.list("product").await.unwrap()), after);
}

#[sqlx::test(migrations = "../../migrations")]
async fn onboarding_rolls_back_default_adaptation_on_another_conflict(pool: PgPool) {
    let service = Service { pool: pool.clone() };
    let profile = industry::templates()
        .into_iter()
        .find(|p| p.code == "grocery")
        .unwrap();
    service.save(definition("brand", "integer")).await.unwrap();
    let before = json!(service.list("product").await.unwrap());
    let events: i64 = sqlx::query_scalar("SELECT count(*) FROM platform.outbox")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(service.onboard_industry(profile.id, 0).await.is_err());
    assert_eq!(json!(service.list("product").await.unwrap()), before);
    assert_eq!(service.configuration().await.unwrap().version, 0);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM platform.outbox")
            .fetch_one(&pool)
            .await
            .unwrap(),
        events
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn onboarding_preserves_defaults_referenced_by_another_merchant_set(pool: PgPool) {
    let service = Service { pool: pool.clone() };
    let profile = industry::templates()
        .into_iter()
        .find(|p| p.code == "grocery")
        .unwrap();
    let weight = service
        .list("product")
        .await
        .unwrap()
        .into_iter()
        .find(|d| d.attribute_code == "weight")
        .unwrap();
    let set_id = Uuid::new_v4();
    sqlx::query("INSERT INTO attributes.sets(id,name,description) VALUES($1,'Merchant set','Merchant configuration')").bind(set_id).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO attributes.set_members(set_id,definition_id,group_name,position) VALUES($1,$2,'Shipping',10)").bind(set_id).bind(weight.id).execute(&pool).await.unwrap();
    let before = json!(service.list("product").await.unwrap());
    assert!(service.onboard_industry(profile.id, 0).await.is_err());
    assert_eq!(json!(service.list("product").await.unwrap()), before);
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_first_onboarding_configures_defaults_once(pool: PgPool) {
    let service = Service { pool: pool.clone() };
    let profile = industry::templates()
        .into_iter()
        .find(|p| p.code == "grocery")
        .unwrap();
    let (first, second) = tokio::join!(
        service.onboard_industry(profile.id, 0),
        service.onboard_industry(profile.id, 0)
    );
    assert_eq!(usize::from(first.is_ok()) + usize::from(second.is_ok()), 1);
    assert!(matches!(
        first.as_ref().err().or(second.as_ref().err()),
        Some(infra_auth::Error::Conflict)
    ));
    assert_eq!(service.configuration().await.unwrap().version, 1);
    let weight = service
        .list("product")
        .await
        .unwrap()
        .into_iter()
        .find(|d| d.attribute_code == "weight")
        .unwrap();
    assert_eq!(weight.metadata.unit.as_deref(), Some("g"));
    assert_eq!(weight.version, 2);
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM attributes.industry_profiles")
            .fetch_one(&pool)
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM attributes.sets WHERE name='Grocery Default'"
        )
        .fetch_one(&pool)
        .await
        .unwrap(),
        1
    );
}
