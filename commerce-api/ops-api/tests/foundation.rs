//! Opt-in HTTP contract tests backed by an isolated, real PostgreSQL database.
//! See README.md for the disposable-container command and required environment.
use std::{future::Future, time::Duration};

use axum::{
    body::{to_bytes, Body},
    http::Request,
    Router,
    response::IntoResponse,
};
use rocento_onboard_api::{
    accounts::{Accounts, SecretBox},
    drafts::Drafts,
    routes, AppState,
};
use serde_json::{json, Value};
use sqlx::{postgres::PgPoolOptions, PgPool};
use tower::ServiceExt;
use uuid::Uuid;

const PASSWORD: &str = "synthetic-test-password";

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn billing_migration_preserves_legacy_drafts_and_normalizes_method() {
    database_test(|f| async move {
        let mut tx = f.db.begin().await.unwrap();
        sqlx::Executor::execute(&mut *tx, "CREATE SCHEMA upgrade_fixture; SET LOCAL search_path TO upgrade_fixture")
            .await.unwrap();
        for sql in [
            include_str!("../database/migrations/001_foundation.sql"),
            include_str!("../database/migrations/002_accounts_and_drafts.sql"),
            include_str!("../database/migrations/003_reservation_expiry.sql"),
        ] { sqlx::Executor::execute(&mut *tx, sql).await.unwrap(); }
        for (payment, version) in [("PADDLE", 7), ("MANUAL_CASH", 8)] {
            let org = Uuid::new_v4();
            sqlx::query("INSERT INTO organizations(id,name) VALUES($1,'Legacy organization')")
                .bind(org).execute(&mut *tx).await.unwrap();
            sqlx::query("INSERT INTO onboarding_drafts(id,org_id,brand,payment,version) VALUES($1,$2,'Preserved brand',$3,$4)")
                .bind(Uuid::new_v4()).bind(org).bind(payment).bind(version).execute(&mut *tx).await.unwrap();
        }
        sqlx::Executor::execute(&mut *tx, include_str!("../database/migrations/004_rocento_offline_billing.sql"))
            .await.unwrap();
        let preserved: i64 = sqlx::query_scalar("SELECT count(*) FROM onboarding_drafts WHERE payment='ROCENTO' AND brand='Preserved brand' AND version IN (7,8)")
            .fetch_one(&mut *tx).await.unwrap();
        assert_eq!(preserved, 2);
        assert!(sqlx::query("UPDATE onboarding_drafts SET payment='PADDLE'").execute(&mut *tx).await.is_err());
        tx.rollback().await.unwrap();
    }).await;
}

#[derive(Clone)]
struct Fixture {
    db: PgPool,
    app: Router,
    box_: SecretBox,
}

async fn database_test<F, Fut>(test: F)
where
    F: FnOnce(Fixture) -> Fut + Send + 'static,
    Fut: Future<Output = ()> + Send + 'static,
{
    let raw = std::env::var("ONBOARDING_TEST_DATABASE_URL")
        .expect("set ONBOARDING_TEST_DATABASE_URL to the disposable PostgreSQL admin database");
    let mut url = url::Url::parse(&raw).expect("valid test database URL");
    assert!(matches!(url.scheme(), "postgres" | "postgresql"));
    assert_eq!(
        url.host_str(),
        Some("127.0.0.1"),
        "tests require IPv4 loopback"
    );
    assert_eq!(
        url.path(),
        "/onboarding_test_admin",
        "use the disposable admin database"
    );
    assert!(
        url.query().is_none(),
        "connection overrides are not allowed"
    );
    let admin = PgPoolOptions::new()
        .max_connections(1)
        .connect(&raw)
        .await
        .unwrap();
    let name = format!("onboarding_test_{}", Uuid::new_v4().simple());
    sqlx::query(&format!("CREATE DATABASE {name}"))
        .execute(&admin)
        .await
        .unwrap();
    url.set_path(&format!("/{name}"));
    let database_url = url.to_string();
    let result = tokio::spawn(async move {
        // Exercise the actual migration binary, including a no-op second run.
        for pass in 0..2 {
            let output = tokio::process::Command::new(env!("CARGO_BIN_EXE_migrate"))
                .current_dir(env!("CARGO_MANIFEST_DIR"))
                .env("DATABASE_URL", &database_url)
                .output()
                .await
                .unwrap();
            assert!(
                output.status.success(),
                "migration failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(
                String::from_utf8_lossy(&output.stdout).lines().count(),
                if pass == 0 { 11 } else { 0 }
            );
        }
        let db = PgPoolOptions::new()
            .max_connections(8)
            .acquire_timeout(Duration::from_secs(5))
            .connect(&database_url)
            .await
            .unwrap();
        let box_ = SecretBox::new(&"31".repeat(32)).unwrap();
        let state = AppState {
            billing: rocento_onboard_api::billing::BillingConfig::default(),
            db: db.clone(),
            accounts: Some(Accounts::new(db.clone(), box_.clone()).unwrap()),
            mailer: None,
            local_auth_enabled: false,
            local_customer_token: None,
            production: false,
            request_window: Default::default(),
        };
        test(Fixture {
            db,
            app: routes::router(state),
            box_,
        })
        .await;
    })
    .await;
    // Cleanup also runs after a scenario assertion panics. Never drop the supplied DB.
    sqlx::query(&format!("DROP DATABASE {name} WITH (FORCE)"))
        .execute(&admin)
        .await
        .unwrap();
    admin.close().await;
    result.unwrap();
}

impl Fixture {
    fn with_billing(&self) -> Self {
        let billing = rocento_onboard_api::billing::BillingConfig {
            instructions: "Synthetic fixture instructions; no real payment destination.".to_owned(),
            terms: [(
                "LAUNCH".to_owned(),
                rocento_onboard_api::billing::PaymentTerms {
                    amount_minor: 7900,
                    currency: "USD".to_owned(),
                    service_days: 30,
                },
            )]
            .into(),
            operator_id: "fixture-billing-operator".to_owned(),
            operator_token: "b".repeat(64),
        };
        billing.validate().unwrap();
        let state = AppState {
            billing,
            db: self.db.clone(),
            accounts: Some(Accounts::new(self.db.clone(), self.box_.clone()).unwrap()),
            mailer: None,
            local_auth_enabled: false,
            local_customer_token: None,
            production: false,
            request_window: Default::default(),
        };
        Self {
            app: routes::router(state),
            ..self.clone()
        }
    }

    async fn payment(&self, token: &str, slug: &str) -> Value {
        let draft = self.draft(token, slug).await;
        assert_eq!(self.reserve(token, &draft).await.0, 200);
        self.ok(
            "POST",
            &format!(
                "/onboarding/drafts/{}/payment-request",
                draft["id"].as_str().unwrap()
            ),
            Some(token),
            json!({}),
        )
        .await
    }

    async fn confirm(&self, payment: &Value, receipt: &str) -> (u16, Value) {
        // Core transaction fixtures bypass code issuance; HTTP redemption is tested separately.
        match rocento_onboard_api::billing::confirm(&self.db, "fixture-billing-operator", Uuid::parse_str(payment["id"].as_str().unwrap()).unwrap(), rocento_onboard_api::billing::Confirmation {
            receipt_reference: receipt.into(), amount_minor: payment["amountMinor"].as_i64().unwrap(), currency: payment["currency"].as_str().unwrap().into(), service_days: payment["serviceDays"].as_i64().unwrap() as i32,
        }).await {
            Ok(value) => (200,value),
            Err(error) => { let response=error.into_response(); let status=response.status().as_u16(); let bytes=to_bytes(response.into_body(),1024*1024).await.unwrap(); (status,serde_json::from_slice(&bytes).unwrap()) }
        }
    }
    async fn call(
        &self,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Value,
    ) -> (u16, Value) {
        let mut request = Request::builder()
            .method(method)
            .uri(format!("/api/v1{path}"))
            .header("content-type", "application/json");
        if let Some(token) = token {
            request = request.header("authorization", format!("Bearer {token}"));
        }
        let response = self
            .app
            .clone()
            .oneshot(request.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        assert_eq!(response.headers()["cache-control"], "no-store");
        let status = response.status().as_u16();
        let bytes = to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| json!({"message": String::from_utf8_lossy(&bytes)})))
    }

    async fn ok(&self, method: &str, path: &str, token: Option<&str>, body: Value) -> Value {
        let (status, value) = self.call(method, path, token, body).await;
        assert_eq!(status, 200, "{method} {path}: {value}");
        value
    }

    async fn challenge(&self, email: &str, purpose: &str) -> String {
        let encrypted: String = sqlx::query_scalar(
            "SELECT d.encrypted_payload FROM auth_deliveries d JOIN account_challenges c ON c.id=d.id \
             JOIN customer_accounts a ON a.id=c.account_id WHERE a.email=$1 AND c.purpose=$2")
            .bind(email).bind(purpose).fetch_one(&self.db).await.unwrap();
        self.box_.open(&encrypted).unwrap()["token"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    async fn customer(&self, email: &str, verified: bool) -> String {
        self.ok(
            "POST",
            "/customer/auth/register",
            None,
            json!({"identifier":email,"password":PASSWORD}),
        )
        .await;
        if verified {
            let token = self.challenge(email, "verify").await;
            self.ok(
                "POST",
                "/customer/auth/verify",
                None,
                json!({"identifier":email,"token":token}),
            )
            .await;
        }
        self.ok(
            "POST",
            "/customer/auth/login",
            None,
            json!({"identifier":email,"password":PASSWORD}),
        )
        .await["sessionToken"]
            .as_str()
            .unwrap()
            .to_owned()
    }

    async fn draft(&self, token: &str, slug: &str) -> Value {
        let draft = self
            .ok("GET", "/onboarding/draft", Some(token), Value::Null)
            .await;
        self.ok(
            "PUT",
            &format!("/onboarding/drafts/{}", draft["id"].as_str().unwrap()),
            Some(token),
            json!({"version":draft["version"],"brand":"Fixture store","slug":slug,
                "plan":"LAUNCH","theme":"grocery","payment":"PADDLE"}),
        )
        .await
    }

    async fn reserve(&self, token: &str, draft: &Value) -> (u16, Value) {
        self.call(
            "POST",
            &format!(
                "/onboarding/drafts/{}/reserve",
                draft["id"].as_str().unwrap()
            ),
            Some(token),
            json!({"version":draft["version"]}),
        )
        .await
    }

    async fn count(&self, sql: &str) -> i64 {
        sqlx::query_scalar(sql).fetch_one(&self.db).await.unwrap()
    }
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn payment_requests_use_approved_calendar_terms() {
    database_test(|f| async move {
        let a = f.customer("payer@example.test", true).await;
        let b = f.customer("outsider@example.test", true).await;
        let draft = f.draft(&a, "payment-store").await;
        assert_eq!(draft["payment"], "ROCENTO"); // Legacy draft input is canonicalized.
        let path = format!(
            "/onboarding/drafts/{}/payment-request",
            draft["id"].as_str().unwrap()
        );
        assert_eq!(f.call("POST", &path, Some(&a), json!({})).await.0, 409);
        assert_eq!(f.reserve(&a, &draft).await.0, 200);

        let g = f.with_billing();
        assert_eq!(g.call("POST", &path, None, json!({})).await.0, 401);
        assert_eq!(g.call("POST", &path, Some(&b), json!({})).await.0, 404);
        let (left, right) = tokio::join!(
            g.call(
                "POST",
                &path,
                Some(&a),
                json!({"amountMinor":1,"currency":"USD","serviceDays":999})
            ),
            g.call("POST", &path, Some(&a), json!({}))
        );
        assert_eq!(left.0, 422, "{left:?}");
        assert_eq!(right.0, 200, "{right:?}");
        let left = right;
        assert_eq!(left.1["amountMinor"], 7900);
        assert_eq!(left.1["currency"], "USD");
        assert_eq!(left.1["serviceDays"], 30);
        assert_eq!(left.1["method"], "ROCENTO");
        assert_eq!(left.1["status"], "AWAITING_PAYMENT");
        assert_eq!(g.count("SELECT count(*) FROM payment_requests").await, 1);
        assert_eq!(
            g.count("SELECT count(*) FROM billing_entitlements").await,
            0
        );
        assert_eq!(
            g.ok("GET", "/billing/payment-requests", Some(&b), Value::Null)
                .await,
            json!({"items":[]})
        );
        assert_eq!(
            g.ok("GET", "/billing/payment-requests", Some(&a), Value::Null)
                .await["items"][0]["id"],
            left.1["id"]
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn payment_confirmation_requires_permission_and_is_once_only() {
    database_test(|f| async move {
        let g = f.with_billing();
        let token = g.customer("confirm@example.test", true).await;
        let payment = g.payment(&token, "confirmed-store").await;
        let inspect = format!("/operator/billing/payment-requests/{}", payment["id"].as_str().unwrap());
        assert_eq!(g.call("GET", &inspect, Some(&token), Value::Null).await.0, 403);
        assert_eq!(g.ok("GET", &inspect, Some(&"b".repeat(64)), Value::Null).await["amountMinor"], 7900);
        let path = format!("/operator/billing/payment-requests/{}/confirm", payment["id"].as_str().unwrap());
        let body = json!({"receiptReference":"receipt-001","amountMinor":7900,"currency":"USD","serviceDays":30});
        for auth in [None, Some(token.as_str()), Some("wrong-operator-token")] {
            assert_eq!(g.call("POST", &path, auth, body.clone()).await.0, 403);
        }
        // An unconfigured server cannot accept even the fixture operator token.
        assert_eq!(f.call("POST", &path, Some(&"b".repeat(64)), body.clone()).await.0, 403);
        for (key, value) in [("amountMinor", json!(1)), ("currency", json!("EGP")), ("serviceDays", json!(31))] {
            let mut wrong = body.clone(); wrong[key] = value;
            assert_eq!(g.call("POST", &path, Some(&"b".repeat(64)), wrong).await,
                (409, json!({"code":"PAYMENT_TERMS_MISMATCH"})));
        }
        let (left, right) = tokio::join!(g.confirm(&payment, "receipt-001"), g.confirm(&payment, "receipt-001"));
        assert_eq!(left.0, 200, "{left:?}"); assert_eq!(right.0, 200, "{right:?}");
        assert_eq!(left.1["status"], "CONFIRMED");
        assert!(left.1.get("receiptReference").is_none());
        assert_eq!(g.count("SELECT count(*) FROM billing_entitlements WHERE service_days=30").await, 1);
        assert_eq!(g.count("SELECT count(*) FROM payment_confirmations WHERE operator_id='fixture-billing-operator'").await, 1);
        assert_eq!(g.count("SELECT count(*) FROM audit_events WHERE action='billing.confirmed'").await, 1);
        assert_eq!(g.count("SELECT count(*) FROM outbox_events WHERE subject='rocento.control.billing.confirmed'").await, 1);
        assert_eq!(g.count("SELECT count(*) FROM tenants WHERE lifecycle_status='QUEUED'").await, 1);
        assert_eq!(g.count("SELECT count(*) FROM tenants WHERE lifecycle_status='ACTIVE'").await, 0);
        assert_eq!(g.confirm(&payment, "another-receipt").await.0, 409);
        assert!(sqlx::query("DELETE FROM payment_confirmations").execute(&g.db).await.is_err());
        sqlx::query("UPDATE tenants SET slug_reserved_until=clock_timestamp()-interval '1 second'").execute(&g.db).await.unwrap();
        assert_eq!(Drafts::new(g.db.clone()).reconcile_expired_reservations(None).await.unwrap(), 0);
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn receipts_cannot_pay_twice_and_expiry_cannot_grant_entitlement() {
    database_test(|f| async move {
        let g = f.with_billing();
        let a = g.customer("one@example.test", true).await;
        let b = g.customer("two@example.test", true).await;
        let ap = g.payment(&a, "first-paid-store").await;
        let bp = g.payment(&b, "second-paid-store").await;
        let (left, right) = tokio::join!(g.confirm(&ap, "shared-receipt"), g.confirm(&bp, "shared-receipt"));
        let mut statuses = [left.0, right.0]; statuses.sort();
        assert_eq!(statuses, [200, 409], "{left:?} {right:?}");
        let unpaid = if left.0 == 409 { ap } else { bp };
        assert_eq!(g.count("SELECT count(*) FROM billing_entitlements").await, 1);
        assert_eq!(g.count("SELECT count(*) FROM tenants WHERE lifecycle_status='SLUG_RESERVED'").await, 1);
        sqlx::query("UPDATE tenants SET slug_reserved_until=clock_timestamp()-interval '1 second' WHERE lifecycle_status='SLUG_RESERVED'")
            .execute(&g.db).await.unwrap();
        let drafts = Drafts::new(g.db.clone());
        let (expiry, confirmation) = tokio::join!(drafts.reconcile_expired_reservations(None), g.confirm(&unpaid, "late-receipt"));
        // SKIP LOCKED may defer this row while confirmation holds the draft lock.
        let released = expiry.unwrap();
        assert_eq!(released + drafts.reconcile_expired_reservations(None).await.unwrap(), 1);
        assert_eq!(confirmation, (409, json!({"code":"PAYMENT_EXPIRED"})));
        assert_eq!(g.count("SELECT count(*) FROM payment_requests WHERE status='EXPIRED'").await, 1);
        assert_eq!(g.count("SELECT count(*) FROM billing_entitlements").await, 1);
        assert_eq!(g.count("SELECT count(*) FROM tenants WHERE lifecycle_status='QUEUED'").await, 1);
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn payment_confirmation_rolls_back_when_event_write_fails() {
    database_test(|f| async move {
        let g = f.with_billing();
        let token = g.customer("billing-rollback@example.test", true).await;
        let payment = g.payment(&token, "billing-rollback").await;
        sqlx::raw_sql("CREATE FUNCTION fail_billing_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
            IF NEW.subject='rocento.control.billing.confirmed' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$; \
            CREATE TRIGGER fail_billing_event BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION fail_billing_event();")
            .execute(&g.db).await.unwrap();
        assert_eq!(g.confirm(&payment, "rollback-receipt").await.0, 503);
        assert_eq!(g.count("SELECT count(*) FROM payment_requests WHERE status='CONFIRMED'").await, 0);
        assert_eq!(g.count("SELECT count(*) FROM billing_entitlements").await, 0);
        assert_eq!(g.count("SELECT count(*) FROM payment_confirmations").await, 0);
        assert_eq!(g.count("SELECT count(*) FROM audit_events WHERE action='billing.confirmed'").await, 0);
        assert_eq!(g.count("SELECT count(*) FROM tenants WHERE lifecycle_status='SLUG_RESERVED'").await, 1);
        sqlx::query("DROP TRIGGER fail_billing_event ON outbox_events").execute(&g.db).await.unwrap();
        assert_eq!(g.confirm(&payment, "rollback-receipt").await.0, 200);
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn accounts_verification_reset_and_session_revocation() {
    database_test(|f| async move {
        assert_eq!(
            f.call("GET", "/onboarding/draft", None, Value::Null)
                .await
                .0,
            401
        );
        let email = "account@example.test";
        let token = f.customer(email, false).await;
        let draft = f.draft(&token, "account-store").await;
        assert_eq!(
            f.reserve(&token, &draft).await,
            (403, json!({"code":"EMAIL_VERIFICATION_REQUIRED"}))
        );
        let challenge = f.challenge(email, "verify").await;
        let body = json!({"identifier":email,"token":challenge});
        f.ok("POST", "/customer/auth/verify", None, body.clone())
            .await;
        assert_eq!(
            f.call("POST", "/customer/auth/verify", None, body).await.0,
            400
        );
        assert_eq!(
            f.ok("GET", "/me", Some(&token), Value::Null).await["verified"],
            true
        );
        assert_eq!(f.reserve(&token, &draft).await.0, 200);
        assert_eq!(
            f.call(
                "POST",
                "/customer/auth/login",
                None,
                json!({"identifier":email,"password":"incorrect-password"})
            )
            .await
            .0,
            401
        );
        f.ok(
            "POST",
            "/customer/auth/forgot-password",
            None,
            json!({"identifier":email}),
        )
        .await;
        let reset = f.challenge(email, "reset").await;
        let body = json!({"identifier":email,"token":reset,"password":"replacement-password"});
        f.ok("POST", "/customer/auth/reset-password", None, body.clone())
            .await;
        assert_eq!(
            f.call("POST", "/customer/auth/reset-password", None, body)
                .await
                .0,
            400
        );
        assert_eq!(f.call("GET", "/me", Some(&token), Value::Null).await.0, 401);
        assert_eq!(
            f.call(
                "POST",
                "/customer/auth/login",
                None,
                json!({"identifier":email,"password":PASSWORD})
            )
            .await
            .0,
            401
        );
        let login = f
            .ok(
                "POST",
                "/customer/auth/login",
                None,
                json!({"identifier":email,"password":"replacement-password"}),
            )
            .await;
        let token = login["sessionToken"].as_str().unwrap();
        f.ok("POST", "/customer/auth/logout", Some(token), Value::Null)
            .await;
        assert_eq!(f.call("GET", "/me", Some(token), Value::Null).await.0, 401);
        assert_eq!(f.count("SELECT count(*) FROM customer_sessions").await, 0);
    })
    .await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn draft_versions_and_organization_isolation() {
    database_test(|f| async move {
        let a = f.customer("a@example.test", true).await;
        let b = f.customer("b@example.test", true).await;
        let draft = f.draft(&a, "isolated-store").await;
        let path = format!("/onboarding/drafts/{}", draft["id"].as_str().unwrap());
        let body = json!({"version":draft["version"],"brand":"Fixture store","slug":"isolated-store",
            "plan":"LAUNCH","theme":"grocery","payment":"PADDLE"});
        assert_eq!(f.call("PUT", &path, Some(&b), body.clone()).await.0, 404);
        assert_eq!(f.reserve(&b, &draft).await.0, 404);
        let (left, right) = tokio::join!(f.call("PUT", &path, Some(&a), body.clone()), f.call("PUT", &path, Some(&a), body));
        let mut statuses = [left.0, right.0]; statuses.sort();
        assert_eq!(statuses, [200, 409]);
        let current = f.ok("GET", "/onboarding/draft", Some(&a), Value::Null).await;
        assert_eq!(current["version"].as_i64().unwrap(), draft["version"].as_i64().unwrap() + 1);
        let (status, reserved) = f.reserve(&a, &current).await; assert_eq!(status, 200, "{reserved}");
        let path = format!("/stores/{}", reserved["tenant"]["id"].as_str().unwrap());
        assert_eq!(f.call("GET", &path, Some(&b), Value::Null).await.0, 404);
        assert_eq!(f.ok("GET", "/stores", Some(&b), Value::Null).await, json!([]));
        assert_eq!(f.ok("GET", &path, Some(&a), Value::Null).await["id"], reserved["tenant"]["id"]);
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn expired_credentials_and_cross_account_challenges_are_rejected() {
    database_test(|f| async move {
        let a = f.customer("expired@example.test", false).await;
        let b = f.customer("other@example.test", false).await;
        let challenge_a = f.challenge("expired@example.test", "verify").await;
        let challenge_b = f.challenge("other@example.test", "verify").await;
        assert_eq!(f.call("POST", "/customer/auth/verify", None,
            json!({"identifier":"expired@example.test","token":challenge_b})).await.0, 400);
        sqlx::query("UPDATE account_challenges SET expires_at=clock_timestamp()-interval '1 second' \
            WHERE account_id=(SELECT id FROM customer_accounts WHERE email='expired@example.test')")
            .execute(&f.db).await.unwrap();
        assert_eq!(f.call("POST", "/customer/auth/verify", None,
            json!({"identifier":"expired@example.test","token":challenge_a})).await.0, 400);
        assert_eq!(f.count("SELECT count(*) FROM customer_accounts WHERE verified").await, 0);
        sqlx::query("UPDATE customer_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1")
            .bind(rocento_onboard_api::accounts::digest(&a)).execute(&f.db).await.unwrap();
        assert_eq!(f.call("GET", "/me", Some(&a), Value::Null).await.0, 401);
        sqlx::query("UPDATE customer_accounts SET disabled=true WHERE email='other@example.test'")
            .execute(&f.db).await.unwrap();
        assert_eq!(f.call("GET", "/me", Some(&b), Value::Null).await.0, 401);
        assert_eq!(f.call("POST", "/customer/auth/login", None,
            json!({"identifier":"other@example.test","password":PASSWORD})).await.0, 401);
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn concurrent_slug_reservations_have_one_winner() {
    database_test(|f| async move {
        let a = f.customer("a@example.test", true).await;
        let b = f.customer("b@example.test", true).await;
        let ad = f.draft(&a, "contested-store").await;
        let bd = f.draft(&b, "contested-store").await;
        let (left, right) = tokio::join!(f.reserve(&a, &ad), f.reserve(&b, &bd));
        let mut statuses = [left.0, right.0];
        statuses.sort();
        assert_eq!(statuses, [200, 409], "{left:?} {right:?}");
        let loser = if left.0 == 409 { &left.1 } else { &right.1 };
        assert_eq!(loser["code"], "SLUG_UNAVAILABLE");
        assert_eq!(f.count("SELECT count(*) FROM tenants").await, 1);
        assert_eq!(f.count("SELECT count(*) FROM tenant_domains").await, 2);
        assert_eq!(
            f.count("SELECT count(*) FROM onboarding_drafts WHERE tenant_id IS NOT NULL")
                .await,
            1
        );
        assert_eq!(f.count("SELECT count(*) FROM outbox_events").await, 1);
        assert_eq!(
            f.count("SELECT count(*) FROM audit_events WHERE action='domains.reserved'")
                .await,
            1
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn concurrent_same_draft_reservation_does_not_duplicate_effects() {
    database_test(|f| async move {
        let token = f.customer("repeat@example.test", true).await;
        let draft = f.draft(&token, "repeat-store").await;
        let (left, right) = tokio::join!(f.reserve(&token, &draft), f.reserve(&token, &draft));
        assert_eq!(left.0, 200, "{left:?}");
        assert_eq!(right.0, 200, "{right:?}");
        assert_eq!(left.1["tenant"]["id"], right.1["tenant"]["id"]);
        assert_eq!(f.count("SELECT count(*) FROM tenants").await, 1);
        assert_eq!(f.count("SELECT count(*) FROM tenant_domains").await, 2);
        assert_eq!(f.count("SELECT count(*) FROM outbox_events").await, 1);
        assert_eq!(
            f.count("SELECT count(*) FROM audit_events WHERE action='domains.reserved'")
                .await,
            1
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn expiry_is_once_only_releases_names_and_preserves_active_tenants() {
    database_test(|f| async move {
        let a = f.customer("expiry@example.test", true).await;
        let b = f.customer("reuse@example.test", true).await;
        let draft = f.draft(&a, "reusable-store").await;
        let (status, reservation) = f.reserve(&a, &draft).await; assert_eq!(status, 200);
        sqlx::query("UPDATE tenants SET slug_reserved_until=clock_timestamp()-interval '1 second'")
            .execute(&f.db).await.unwrap();
        let service = Drafts::new(f.db.clone());
        let (left, right) = tokio::join!(service.reconcile_expired_reservations(None), service.reconcile_expired_reservations(None));
        assert_eq!(left.unwrap() + right.unwrap(), 1);
        let current = f.ok("GET", "/onboarding/draft", Some(&a), Value::Null).await;
        assert!(current["tenant_id"].is_null());
        assert_eq!(current["version"].as_i64().unwrap(), reservation["draft"]["version"].as_i64().unwrap()+1);
        assert_eq!(f.count("SELECT count(*) FROM tenant_domains WHERE route_status='EXPIRED'").await, 2);
        assert_eq!(f.count("SELECT count(*) FROM audit_events WHERE action='domains.reservation_expired'").await, 1);
        assert_eq!(f.count("SELECT count(*) FROM outbox_events WHERE subject='rocento.control.domains.reservation_expired'").await, 1);
        let draft = f.draft(&b, "reusable-store").await;
        assert_eq!(f.reserve(&b, &draft).await.0, 200);
        assert_eq!(f.count("SELECT count(*) FROM tenants").await, 2);
        sqlx::query("UPDATE tenants SET lifecycle_status='ACTIVE',slug_reserved_until=clock_timestamp()-interval '1 second' WHERE lifecycle_status='SLUG_RESERVED'")
            .execute(&f.db).await.unwrap();
        assert_eq!(service.reconcile_expired_reservations(None).await.unwrap(), 0);
        assert_eq!(f.count("SELECT count(*) FROM tenants WHERE lifecycle_status='ACTIVE'").await, 1);
        assert_eq!(f.count("SELECT count(*) FROM tenant_domains WHERE route_status='RESERVED'").await, 2);
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn audit_failure_rolls_back_reservation_and_outbox() {
    database_test(|f| async move {
        let token = f.customer("rollback@example.test", true).await;
        let draft = f.draft(&token, "rollback-store").await;
        // Fail after tenant, paired domains and outbox have been inserted.
        sqlx::raw_sql("CREATE FUNCTION fail_reservation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN \
            IF NEW.action='domains.reserved' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$; \
            CREATE TRIGGER fail_reservation_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION fail_reservation_audit();")
            .execute(&f.db).await.unwrap();
        assert_eq!(f.reserve(&token, &draft).await, (503, json!({"code":"SERVICE_UNAVAILABLE"})));
        assert_eq!(f.count("SELECT count(*) FROM tenants").await, 0);
        assert_eq!(f.count("SELECT count(*) FROM tenant_domains").await, 0);
        assert_eq!(f.count("SELECT count(*) FROM outbox_events").await, 0);
        assert_eq!(f.count("SELECT count(*) FROM audit_events WHERE action='domains.reserved'").await, 0);
        let current = f.ok("GET", "/onboarding/draft", Some(&token), Value::Null).await;
        assert_eq!(current["version"], draft["version"]); assert!(current["tenant_id"].is_null());
        sqlx::query("DROP TRIGGER fail_reservation_audit ON audit_events").execute(&f.db).await.unwrap();
        assert_eq!(f.reserve(&token, &draft).await.0, 200);
    }).await;
}

// Provisioning tests use an explicit in-process executor fixture. It never
// creates a real runtime; AWS activation is gated on an installed host executor.
use rocento_onboard_api::provisioning::{self, Evidence, Executor, Failure, Job};
struct GoodExecutor;
fn evidence(job: &Job) -> Evidence {
    Evidence {
        job_id: job.id,
        tenant_id: job.tenant_id,
        lease_token: job.lease_token,
        step: job.step.clone(),
        artifact_digest: job.artifact_digest.clone().unwrap_or_default(),
        checks: [
            "release_authorized",
            "architecture_compatible",
            "artifact_present",
            "capacity_reserved",
            "tenant_isolated",
            "database_ready",
            "installation_identity",
            "theme_ready",
            "ingress_configured",
            "runtime_healthy",
            "migrations_applied",
            "admin_access_ready",
            "storefront_https",
            "admin_https",
            "tenant_identity",
            "release_identity",
            "dns_routing",
            "tenant_isolation",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect(),
    }
}
impl Executor for GoodExecutor {
    async fn execute(&self, job: &Job) -> Result<Evidence, Failure> {
        Ok(evidence(job))
    }
}
async fn paid_fixture(f: &Fixture, slug: &str) -> (String, Value) {
    let token = f.customer(&format!("{slug}@example.test"), true).await;
    let payment = f.payment(&token, slug).await;
    assert_eq!(f.confirm(&payment, &format!("receipt-{slug}")).await.0, 200);
    (token, payment)
}
async fn approve_fixture(db: &PgPool) {
    sqlx::query("UPDATE storefront_themes SET status='APPROVED',version='fixture-v1',artifact_digest=$1,demo_url='https://fixture.example.test' WHERE id='grocery'")
        .bind(format!("sha256:{}","a".repeat(64))).execute(db).await.unwrap();
}
async fn advance_due(db: &PgPool) {
    sqlx::query("UPDATE provisioning_jobs SET next_run_at=clock_timestamp()-interval '1 second' WHERE status IN ('RETRY','BLOCKED')").execute(db).await.unwrap();
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn provisioning_ingest_is_atomic_idempotent_and_approval_blocks_execution() {
    database_test(|base| async move {
        let f = base.with_billing();
        let (token, p) = paid_fixture(&f, "job-blocked").await;
        let (a, b) = tokio::join!(provisioning::ingest(&f.db), provisioning::ingest(&f.db));
        a.unwrap();
        b.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM provisioning_jobs")
                .fetch_one(&f.db)
                .await
                .unwrap(),
            1
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM provisioning_event_receipts")
                .fetch_one(&f.db)
                .await
                .unwrap(),
            1
        );
        assert_eq!(provisioning::ingest(&f.db).await.unwrap(), 0);
        provisioning::run_once(&f.db, &GoodExecutor).await.unwrap();
        let path = format!("/stores/{}/provisioning", p["tenantId"].as_str().unwrap());
        let state = f.ok("GET", &path, Some(&token), json!({})).await;
        assert_eq!(state["status"], "BLOCKED");
        assert_eq!(state["reason"], "APPROVED_RELEASE_REQUIRED");
        assert_eq!(state["lifecycleStatus"], "QUEUED");
        assert!(state["serviceStartsAt"].is_null());
        assert!(state["storefrontUrl"].is_null());
        let other = f.customer("job-other@example.test", true).await;
        assert_eq!(f.call("GET", &path, Some(&other), json!({})).await.0, 404);
        assert_eq!(f.call("GET", &path, None, json!({})).await.0, 401);
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM outbox_events WHERE published_at IS NOT NULL"
            )
            .fetch_one(&f.db)
            .await
            .unwrap(),
            0
        );
        assert!(!provisioning::run_once(&f.db, &GoodExecutor).await.unwrap());
        approve_fixture(&f.db).await;
        advance_due(&f.db).await;
        provisioning::run_once(
            &f.db,
            &rocento_onboard_api::provisioning_executor::HostExecutor,
        )
        .await
        .unwrap();
        let state = f.ok("GET", &path, Some(&token), json!({})).await;
        assert_eq!(state["reason"], "EXECUTOR_NOT_INSTALLED");
        assert_eq!(state["lifecycleStatus"], "QUEUED");
    })
    .await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn provisioning_steps_activate_once_and_start_service_only_after_validation() {
    database_test(|base|async move{
        let f=base.with_billing();let (token,p)=paid_fixture(&f,"job-success").await;approve_fixture(&f.db).await;
        let path=format!("/stores/{}/provisioning",p["tenantId"].as_str().unwrap());
        for expected in ["ALLOCATING","DEPLOYING","DEPLOYING","DEPLOYING","DEPLOYING","DEPLOYING","VALIDATING","ACTIVE"]{
            assert!(provisioning::run_once(&f.db,&GoodExecutor).await.unwrap());
            let state=f.ok("GET",&path,Some(&token),json!({})).await;
            assert_eq!(state["lifecycleStatus"],expected);
            assert_eq!(state["serviceStartsAt"].is_null(),expected!="ACTIVE");
        }
        assert!(!provisioning::run_once(&f.db,&GoodExecutor).await.unwrap());
        let state=f.ok("GET",&path,Some(&token),json!({})).await;
        assert_eq!(state["status"],"SUCCEEDED");assert_eq!(state["step"],"DONE");
        assert_eq!(state["storefrontUrl"],"https://job-success.rocento.com");
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM provisioning_steps").fetch_one(&f.db).await.unwrap(),8);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM tenant_domains WHERE route_status='ACTIVE'").fetch_one(&f.db).await.unwrap(),2);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM audit_events WHERE action='tenant.activated'").fetch_one(&f.db).await.unwrap(),1);
        let days:f64=sqlx::query_scalar("SELECT EXTRACT(EPOCH FROM (ends_at-starts_at))::float8/86400 FROM billing_entitlements").fetch_one(&f.db).await.unwrap();
        assert!((days-30.0).abs()<0.00001);
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn provisioning_concurrent_claim_and_expired_lease_cannot_activate() {
    database_test(|base| async move {
        let f = base.with_billing();
        paid_fixture(&f, "job-lease").await;
        approve_fixture(&f.db).await;
        provisioning::ingest(&f.db).await.unwrap();
        let (a, b) = tokio::join!(provisioning::claim(&f.db), provisioning::claim(&f.db));
        let a = a.unwrap();
        let b = b.unwrap();
        assert_ne!(a.is_some(), b.is_some());
        let mut job = a.or(b).unwrap();
        job.artifact_digest = Some(format!("sha256:{}", "a".repeat(64)));
        job.release_version = Some("fixture-v1".into());
        sqlx::query(
            "UPDATE provisioning_jobs SET lease_until=clock_timestamp()-interval '1 second'",
        )
        .execute(&f.db)
        .await
        .unwrap();
        assert_eq!(provisioning::recover_expired(&f.db).await.unwrap(), 1);
        assert!(!provisioning::complete_step(&f.db, &job, evidence(&job))
            .await
            .unwrap());
        assert!(provisioning::claim(&f.db).await.unwrap().is_none());
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT lifecycle_status FROM tenants")
                .fetch_one(&f.db)
                .await
                .unwrap(),
            "FAILED_REQUIRES_REVIEW"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM billing_entitlements WHERE starts_at IS NOT NULL"
            )
            .fetch_one(&f.db)
            .await
            .unwrap(),
            0
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn provisioning_retries_are_delayed_and_bounded() {
    struct Retry;
    impl Executor for Retry {
        async fn execute(&self, _: &Job) -> Result<Evidence, Failure> {
            Err(Failure::Retry("TEST_TRANSIENT"))
        }
    }
    database_test(|base| async move {
        let f = base.with_billing();
        paid_fixture(&f, "job-retry").await;
        approve_fixture(&f.db).await;
        for attempt in 1..=5 {
            assert!(provisioning::run_once(&f.db, &Retry).await.unwrap());
            assert_eq!(
                sqlx::query_scalar::<_, i32>("SELECT attempts FROM provisioning_jobs")
                    .fetch_one(&f.db)
                    .await
                    .unwrap(),
                attempt
            );
            assert!(!provisioning::run_once(&f.db, &Retry).await.unwrap());
            advance_due(&f.db).await;
        }
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT status FROM provisioning_jobs")
                .fetch_one(&f.db)
                .await
                .unwrap(),
            "FAILED"
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT lifecycle_status FROM tenants")
                .fetch_one(&f.db)
                .await
                .unwrap(),
            "FAILED_REQUIRES_REVIEW"
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn provisioning_rejects_wrong_evidence_and_revoked_release() {
    struct Wrong;
    impl Executor for Wrong {
        async fn execute(&self, j: &Job) -> Result<Evidence, Failure> {
            let mut e = evidence(j);
            e.tenant_id = Uuid::new_v4();
            Ok(e)
        }
    }
    struct Revoke(PgPool);
    impl Executor for Revoke {
        async fn execute(&self, j: &Job) -> Result<Evidence, Failure> {
            sqlx::query("UPDATE storefront_themes SET status='REVOKED'")
                .execute(&self.0)
                .await
                .unwrap();
            Ok(evidence(j))
        }
    }
    database_test(|base| async move {
        let f = base.with_billing();
        paid_fixture(&f, "job-proof").await;
        approve_fixture(&f.db).await;
        provisioning::run_once(&f.db, &Wrong).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT last_error FROM provisioning_jobs")
                .fetch_one(&f.db)
                .await
                .unwrap(),
            "INVALID_EXECUTOR_EVIDENCE"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>("SELECT count(*) FROM provisioning_steps")
                .fetch_one(&f.db)
                .await
                .unwrap(),
            0
        );
    })
    .await;
    database_test(|base| async move {
        let f = base.with_billing();
        paid_fixture(&f, "job-revoke").await;
        approve_fixture(&f.db).await;
        for _ in 0..7 {
            provisioning::run_once(&f.db, &GoodExecutor).await.unwrap();
        }
        provisioning::run_once(&f.db, &Revoke(f.db.clone()))
            .await
            .unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT last_error FROM provisioning_jobs")
                .fetch_one(&f.db)
                .await
                .unwrap(),
            "ELIGIBILITY_CHANGED"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM billing_entitlements WHERE starts_at IS NOT NULL"
            )
            .fetch_one(&f.db)
            .await
            .unwrap(),
            0
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn provisioning_final_transaction_rolls_back_if_a_domain_is_not_reserved() {
    database_test(|base| async move {
        let f = base.with_billing();
        paid_fixture(&f, "job-domains").await;
        approve_fixture(&f.db).await;
        for _ in 0..7 {
            provisioning::run_once(&f.db, &GoodExecutor).await.unwrap();
        }
        sqlx::query("UPDATE tenant_domains SET route_status='EXPIRED' WHERE domain_type='ADMIN'")
            .execute(&f.db)
            .await
            .unwrap();
        provisioning::run_once(&f.db, &GoodExecutor).await.unwrap();
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT last_error FROM provisioning_jobs")
                .fetch_one(&f.db)
                .await
                .unwrap(),
            "DOMAIN_STATE_CHANGED"
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM tenant_domains WHERE route_status='ACTIVE'"
            )
            .fetch_one(&f.db)
            .await
            .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM provisioning_steps WHERE step='VALIDATE'"
            )
            .fetch_one(&f.db)
            .await
            .unwrap(),
            0
        );
        assert_eq!(
            sqlx::query_scalar::<_, i64>(
                "SELECT count(*) FROM billing_entitlements WHERE starts_at IS NOT NULL"
            )
            .fetch_one(&f.db)
            .await
            .unwrap(),
            0
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn paid_store_theme_is_locked_before_job_consumption() {
    database_test(|base| async move {
        let f = base.with_billing();
        let (token, _) = paid_fixture(&f, "job-theme-lock").await;
        let mut draft = f
            .ok("GET", "/onboarding/draft", Some(&token), json!({}))
            .await;
        let path = format!("/onboarding/drafts/{}", draft["id"].as_str().unwrap());
        draft["theme"] = json!("jewelry");
        let (status, error) = f.call("PUT", &path, Some(&token), draft).await;
        assert_eq!(status, 409);
        assert_eq!(error["code"], "RESERVATION_LOCKED");
    })
    .await;
}

async fn staff_token(f: &Fixture, email: &str, role: &str) -> String {
    sqlx::query("INSERT INTO staff_members(account_id,role) SELECT id,$2 FROM customer_accounts WHERE email=$1")
        .bind(email).bind(role).execute(&f.db).await.unwrap();
    f.ok(
        "POST",
        "/staff/auth/login",
        None,
        json!({"identifier":email,"password":PASSWORD}),
    )
    .await["sessionToken"]
        .as_str()
        .unwrap()
        .to_owned()
}
#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn staff_sessions_require_membership_and_are_audience_separated() {
    database_test(|f| async move {
        let customer = f.customer("owner@example.test", true).await;
        assert_eq!(
            f.call("GET", "/staff/dashboard", Some(&customer), Value::Null)
                .await
                .0,
            401
        );
        assert_eq!(
            f.call(
                "POST",
                "/staff/auth/login",
                None,
                json!({"identifier":"owner@example.test","password":PASSWORD})
            )
            .await
            .0,
            403
        );
        let token = staff_token(&f, "owner@example.test", "OWNER").await;
        assert_eq!(f.call("GET", "/me", Some(&token), Value::Null).await.0, 401);
        assert_eq!(
            f.ok("GET", "/staff/me", Some(&token), Value::Null).await["role"],
            "OWNER"
        );
        assert_eq!(
            f.ok("GET", "/staff/dashboard", Some(&token), Value::Null)
                .await["counts"]["clients"],
            0
        );
        f.customer("merchant@example.test", true).await;
        let clients = f.ok("GET", "/staff/clients", Some(&token), Value::Null).await;
        assert_eq!(clients["total"], 1);
        assert_eq!(clients["items"][0]["email"], "merchant@example.test");
        assert_eq!(f.ok("GET", "/staff/dashboard", Some(&token), Value::Null).await["counts"]["clients"], 1);
        f.ok("POST", "/staff/auth/logout", Some(&token), json!({}))
            .await;
        assert_eq!(
            f.call("GET", "/staff/me", Some(&token), Value::Null)
                .await
                .0,
            401
        );
    })
    .await;
}
#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn staff_payment_confirmation_and_role_revocation() {
    database_test(|base|async move{
    let f=base.with_billing();
    let customer=f.customer("owner@example.test",true).await;
    let owner=staff_token(&f,"owner@example.test","OWNER").await;
    let payment=f.payment(&customer,"staff-payment").await;
    let path=format!("/staff/payments/{}/confirm",payment["id"].as_str().unwrap());
    let body=json!({"receiptReference":"staff-receipt","amountMinor":7900,"currency":"USD","serviceDays":30});
    assert_eq!(f.call("POST",&path,Some(&customer),body.clone()).await.0,401);
    let issued=f.ok("POST",&path,Some(&owner),body.clone()).await;
    assert_eq!(f.count("SELECT count(*) FROM payment_confirmations").await,0);
    let redeem=format!("/billing/payment-requests/{}/redeem",payment["id"].as_str().unwrap());
    f.ok("POST",&redeem,Some(&customer),json!({"code":issued["code"]})).await;
    f.ok("POST",&redeem,Some(&customer),json!({"code":issued["code"]})).await;
    assert_eq!(f.count("SELECT count(*) FROM payment_confirmations").await,1);
    sqlx::query("UPDATE staff_members SET role='VIEWER'").execute(&f.db).await.unwrap();
    assert_eq!(f.call("POST",&path,Some(&owner),body.clone()).await.0,403);
    sqlx::query("UPDATE staff_members SET enabled=false").execute(&f.db).await.unwrap();
    assert_eq!(f.call("GET","/staff/dashboard",Some(&owner),Value::Null).await.0,401);
 }).await;
}
#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn staff_suspend_prevents_provisioning_and_preserves_payment() {
    database_test(|base| async move {
        let f = base.with_billing();
        let (_, payment) = paid_fixture(&f, "staff-suspend").await;
        let owner = staff_token(&f, "staff-suspend@example.test", "OWNER").await;
        provisioning::ingest(&f.db).await.unwrap();
        approve_fixture(&f.db).await;
        let id = payment["tenantId"].as_str().unwrap();
        let path = format!("/staff/stores/{id}/control");
        let body =
            json!({"action":"SUSPEND","reason":"Fixture pause","confirmSlug":"staff-suspend"});
        assert_eq!(
            f.call(
                "POST",
                &path,
                Some(&owner),
                json!({"action":"SUSPEND","reason":"Fixture pause","confirmSlug":"wrong"})
            )
            .await
            .0,
            409
        );
        let first = f.ok("POST", &path, Some(&owner), body.clone()).await;
        let second = f.ok("POST", &path, Some(&owner), body).await;
        assert_eq!(first["id"], second["id"]);
        assert!(!provisioning::run_once(&f.db, &GoodExecutor).await.unwrap());
        assert_eq!(f.count("SELECT count(*) FROM provisioning_steps").await, 0);
        assert_eq!(
            f.count("SELECT count(*) FROM payment_confirmations").await,
            1
        );
        assert_eq!(
            f.count("SELECT count(*) FROM tenant_control_commands")
                .await,
            1
        );
        assert_eq!(
            f.count("SELECT count(*) FROM billing_entitlements WHERE starts_at IS NOT NULL")
                .await,
            0
        );
        let detail = f
            .ok(
                "GET",
                &format!("/staff/stores/{id}"),
                Some(&owner),
                Value::Null,
            )
            .await;
        assert_eq!(detail["store"]["managementState"], "SUSPEND_REQUESTED");
        assert_eq!(
            f.call(
                "POST",
                &path,
                Some(&owner),
                json!({"action":"ARCHIVE","reason":"Archive fixture","confirmSlug":"staff-suspend"})
            )
            .await
            .0,
            409
        );
    })
    .await;
}
#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn staff_archive_unpaid_store_blocks_payment_and_cannot_delete() {
    database_test(|base|async move{
    let f=base.with_billing();let customer=f.customer("archive@example.test",true).await;
    f.customer("archive-staff@example.test",true).await;
    let owner=staff_token(&f,"archive-staff@example.test","OWNER").await;
    let payment=f.payment(&customer,"staff-archive").await;let id=payment["tenantId"].as_str().unwrap();
    f.ok("POST",&format!("/staff/stores/{id}/control"),Some(&owner),json!({"action":"ARCHIVE","reason":"Retain archived fixture","confirmSlug":"staff-archive"})).await;
    assert_eq!(f.confirm(&payment,"too-late").await.0,409);
    assert_eq!(f.count("SELECT count(*) FROM tenants").await,1);
    assert_eq!(f.count("SELECT count(*) FROM tenant_domains").await,2);
    let list=f.ok("GET","/staff/clients?search=archive%40example.test&page=0",Some(&owner),Value::Null).await;
    assert_eq!(list["total"],1);
    assert_eq!(list["items"][0]["stores"][0]["managementState"],"ARCHIVE_REQUESTED");
    sqlx::query("UPDATE tenants SET slug_reserved_until=clock_timestamp()-interval '1 hour'").execute(&f.db).await.unwrap();
    f.ok("GET","/onboarding/draft",Some(&customer),Value::Null).await;
    assert_eq!(f.count("SELECT count(*) FROM tenants WHERE management_state='ARCHIVE_REQUESTED' AND lifecycle_status='SLUG_RESERVED'").await,1);
    let command: String=sqlx::query_scalar("UPDATE tenant_control_commands SET status='APPLYING' RETURNING id::text").fetch_one(&f.db).await.unwrap();
    let output=std::process::Command::new("python3").arg("-c").arg("import importlib.util,json,sys; s=importlib.util.spec_from_file_location('controls','../../commerce-ops/cloud/host/tenant_controls.py'); m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(m.complete_sql(json.loads(sys.argv[1])))").arg(json!({"id":command,"tenantId":id,"slug":"staff-archive","action":"ARCHIVE"}).to_string()).output().unwrap();
    assert!(output.status.success());
    sqlx::raw_sql(std::str::from_utf8(&output.stdout).unwrap()).execute(&f.db).await.unwrap();
    assert_eq!(f.count("SELECT count(*) FROM tenants WHERE management_state='ARCHIVED' AND archived_at IS NOT NULL").await,1);
    assert_eq!(f.count("SELECT count(*) FROM tenant_domains WHERE route_status='SUSPENDED'").await,2);
    assert_eq!(f.count("SELECT count(*) FROM tenant_control_commands WHERE status='APPLIED'").await,1);
 }).await;
}
#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn staff_password_reset_revokes_staff_session() {
    database_test(|f|async move{
    f.customer("reset-staff@example.test",true).await;
    let owner=staff_token(&f,"reset-staff@example.test","OWNER").await;
    f.ok("POST","/customer/auth/forgot-password",None,json!({"identifier":"reset-staff@example.test"})).await;
    let challenge=f.challenge("reset-staff@example.test","reset").await;
    f.ok("POST","/customer/auth/reset-password",None,json!({"identifier":"reset-staff@example.test","token":challenge,"password":"new-synthetic-password"})).await;
    assert_eq!(f.call("GET","/staff/me",Some(&owner),Value::Null).await.0,401);
 }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn suspension_during_final_validation_cannot_activate() {
    struct Suspend(PgPool);
    impl Executor for Suspend {
        async fn execute(&self, job: &Job) -> Result<Evidence, Failure> {
            sqlx::query("UPDATE tenants SET management_state='SUSPEND_REQUESTED' WHERE id=$1")
                .bind(job.tenant_id)
                .execute(&self.0)
                .await
                .unwrap();
            Ok(evidence(job))
        }
    }
    database_test(|base| async move {
        let f = base.with_billing();
        paid_fixture(&f, "suspend-race").await;
        approve_fixture(&f.db).await;
        for _ in 0..7 {
            provisioning::run_once(&f.db, &GoodExecutor).await.unwrap();
        }
        assert_eq!(
            f.count("SELECT count(*) FROM provisioning_jobs WHERE step='VALIDATE'")
                .await,
            1
        );
        provisioning::run_once(&f.db, &Suspend(f.db.clone()))
            .await
            .unwrap();
        assert_eq!(
            f.count("SELECT count(*) FROM tenants WHERE lifecycle_status='ACTIVE'")
                .await,
            0
        );
        assert_eq!(
            f.count("SELECT count(*) FROM billing_entitlements WHERE starts_at IS NOT NULL")
                .await,
            0
        );
        assert_eq!(
            f.count("SELECT count(*) FROM tenant_domains WHERE route_status='ACTIVE'")
                .await,
            0
        );
        assert_eq!(
            f.count("SELECT count(*) FROM audit_events WHERE action='tenant.activated'")
                .await,
            0
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn fleet_staff_provider_selection_is_owner_only_and_locked_after_reservation() {
    database_test(|base| async move {
        let f = base.with_billing();
        let (customer, payment) = paid_fixture(&f, "fleet-staff").await;
        f.customer("fleet-owner@example.test", true).await;
        f.customer("fleet-viewer@example.test", true).await;
        let owner = staff_token(&f, "fleet-owner@example.test", "OWNER").await;
        let viewer = staff_token(&f, "fleet-viewer@example.test", "VIEWER").await;
        let path = format!(
            "/staff/stores/{}/hosting",
            payment["tenantId"].as_str().unwrap()
        );
        assert_eq!(
            f.call("POST", &path, Some(&customer), json!({"provider":"aws"}))
                .await
                .0,
            401
        );
        assert_eq!(
            f.call("POST", &path, Some(&viewer), json!({"provider":"aws"}))
                .await
                .0,
            403
        );
        assert_eq!(
            f.call("POST", &path, Some(&owner), json!({"provider":"shell"}))
                .await
                .0,
            400
        );
        for provider in ["aws", "gcp", "hetzner"] {
            assert_eq!(
                f.ok("POST", &path, Some(&owner), json!({"provider":provider}))
                    .await["provider"],
                provider
            );
        }
        provisioning::ingest(&f.db).await.unwrap();
        let j = provisioning::claim(&f.db).await.unwrap().unwrap();
        assert_eq!(
            f.call("POST", &path, Some(&owner), json!({"provider":"aws"}))
                .await
                .0,
            409
        );
        sqlx::query("UPDATE provisioning_jobs SET artifact_digest=$1,release_version='fixture-v1' WHERE id=$2")
            .bind(format!("sha256:{}", "a".repeat(64)))
            .bind(j.id)
            .execute(&f.db)
            .await
            .unwrap();
        let reserved: Value = sqlx::query_scalar("SELECT reserve_merchant_host($1,$2,$3,2,$4)")
            .bind(j.id)
            .bind(j.lease_token)
            .bind("b".repeat(64))
            .bind(Uuid::new_v4())
            .fetch_one(&f.db)
            .await
            .unwrap();
        assert_eq!(reserved["provider"], "hetzner");
        sqlx::query("UPDATE provisioning_jobs SET status='BLOCKED',lease_token=NULL,lease_until=NULL WHERE id=$1")
            .bind(j.id)
            .execute(&f.db)
            .await
            .unwrap();
        assert_eq!(
            f.call("POST", &path, Some(&owner), json!({"provider":"aws"}))
                .await
                .0,
            409
        );
        assert_eq!(
            f.ok("POST", &path, Some(&owner), json!({"provider":"hetzner"}))
                .await["provider"],
            "hetzner"
        );
        let detail = f
            .ok(
                "GET",
                &path.trim_end_matches("/hosting"),
                Some(&owner),
                Value::Null,
            )
            .await;
        assert_eq!(detail["store"]["hostingLocked"], true);
        assert_eq!(detail["store"]["hostId"], reserved["id"]);
    })
    .await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn fleet_concurrent_reservations_enforce_three_slots_and_provider_isolation() {
    database_test(|base| async move {
        let f=base.with_billing();
        let mut jobs=Vec::new();
        for n in 0..21 {
            let (_,p)=paid_fixture(&f,&format!("fleet-{n}")).await;
            let provider=["aws","gcp","hetzner"][n/7];
            sqlx::query("UPDATE tenants SET hosting_provider=$1 WHERE id=$2")
                .bind(provider).bind(Uuid::parse_str(p["tenantId"].as_str().unwrap()).unwrap()).execute(&f.db).await.unwrap();
            provisioning::ingest(&f.db).await.unwrap();
            let j=provisioning::claim(&f.db).await.unwrap().unwrap();
            sqlx::query("UPDATE provisioning_jobs SET artifact_digest=$1,release_version='fixture-v1' WHERE id=$2")
                .bind(format!("sha256:{}","a".repeat(64))).bind(j.id).execute(&f.db).await.unwrap();
            jobs.push(j);
        }
        let mut tasks=Vec::new();
        for j in jobs.clone() {
            let db=f.db.clone();
            tasks.push(tokio::spawn(async move {
                sqlx::query_scalar::<_,Option<Value>>("SELECT reserve_merchant_host($1,$2,$3,2,$4)")
                    .bind(j.id).bind(j.lease_token).bind("b".repeat(64)).bind(Uuid::new_v4()).fetch_one(&db).await.unwrap()
            }));
        }
        let mut placed=0;
        for task in tasks { if task.await.unwrap().is_some(){placed+=1;} }
        assert_eq!(placed,18); // Each provider gets six slots; its seventh merchant waits.
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT max(n) FROM (SELECT count(*) n FROM merchant_placements GROUP BY host_id) s").fetch_one(&f.db).await.unwrap(),3);
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM merchant_hosts WHERE provider='aws'").fetch_one(&f.db).await.unwrap(),2);
        for provider in ["aws","gcp","hetzner"] {
            assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM merchant_hosts WHERE provider=$1").bind(provider).fetch_one(&f.db).await.unwrap(),2);
            assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM merchant_placements WHERE provider=$1").bind(provider).fetch_one(&f.db).await.unwrap(),6);
        }
        let placed_tenant:Uuid=sqlx::query_scalar("SELECT tenant_id FROM merchant_placements ORDER BY tenant_id LIMIT 1").fetch_one(&f.db).await.unwrap();
        let j=jobs.iter().find(|j| j.tenant_id==placed_tenant).unwrap();
        let before:Option<Value>=sqlx::query_scalar("SELECT reserve_merchant_host($1,$2,$3,2,$4)").bind(j.id).bind(j.lease_token).bind("b".repeat(64)).bind(Uuid::new_v4()).fetch_one(&f.db).await.unwrap();
        let after:Option<Value>=sqlx::query_scalar("SELECT reserve_merchant_host($1,$2,$3,2,$4)").bind(j.id).bind(j.lease_token).bind("b".repeat(64)).bind(Uuid::new_v4()).fetch_one(&f.db).await.unwrap();
        assert!(before.is_some());
        assert_eq!(before,after);
        assert!(sqlx::query("SELECT reserve_merchant_host($1,$2,$3,2,$4)").bind(j.id).bind(None::<Uuid>).bind("b".repeat(64)).bind(Uuid::new_v4()).execute(&f.db).await.is_err());
        assert!(sqlx::query("SELECT reserve_merchant_host($1,$2,$3,$4,$5)").bind(j.id).bind(j.lease_token).bind("b".repeat(64)).bind(None::<i32>).bind(Uuid::new_v4()).execute(&f.db).await.is_err());
        // Failed hosts retain their reservations and consume the configured budget.
        sqlx::query("UPDATE merchant_hosts SET state='FAILED' WHERE provider='aws'").execute(&f.db).await.unwrap();
        assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM merchant_placements WHERE provider='aws'").fetch_one(&f.db).await.unwrap(),6);
        assert!(sqlx::query("UPDATE merchant_placements SET slot=4").execute(&f.db).await.is_err());
        assert!(sqlx::query("UPDATE tenants SET hosting_provider='hetzner' WHERE hosting_provider='aws' AND id IN (SELECT tenant_id FROM merchant_placements)").execute(&f.db).await.is_err());
        assert!(sqlx::query("SELECT reserve_merchant_host($1,$2,$3,2,$4)").bind(j.id).bind(Uuid::new_v4()).bind("b".repeat(64)).bind(Uuid::new_v4()).execute(&f.db).await.is_err());
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn fleet_boot_rechecks_current_merchant_authorization() {
    database_test(|base| async move {
        let f = base.with_billing();
        for provider in ["aws", "gcp", "hetzner"] {
            let (_, payment) = paid_fixture(&f, &format!("boot-{provider}")).await;
            approve_fixture(&f.db).await;
            let tenant = Uuid::parse_str(payment["tenantId"].as_str().unwrap()).unwrap();
            sqlx::query("UPDATE tenants SET hosting_provider=$1 WHERE id=$2").bind(provider).bind(tenant).execute(&f.db).await.unwrap();
            provisioning::ingest(&f.db).await.unwrap();
            let job = provisioning::claim(&f.db).await.unwrap().unwrap();
            let digest = format!("sha256:{}", "a".repeat(64));
            sqlx::query("UPDATE provisioning_jobs SET artifact_digest=$1,release_version='fixture-v1' WHERE id=$2").bind(&digest).bind(job.id).execute(&f.db).await.unwrap();
            let host = Uuid::new_v4();
            let reserved: Option<Value> = sqlx::query_scalar("SELECT reserve_merchant_host($1,$2,$3,2,$4)").bind(job.id).bind(job.lease_token).bind("b".repeat(64)).bind(host).fetch_one(&f.db).await.unwrap();
            assert!(reserved.is_some());
            // Execute the controller's actual query against the migrated schema.
            let script = "import sys,json; sys.path.insert(0,sys.argv[1]); import merchant_fleet; print(merchant_fleet.boot_query(json.loads(sys.argv[2])))";
            let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../commerce-ops/cloud/controller");
            let output = std::process::Command::new("python3").args(["-c", script]).arg(directory).arg(json!({"id":host,"provider":provider,"release_digest":digest}).to_string()).output().unwrap();
            assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
            let query = String::from_utf8(output.stdout).unwrap();
            assert!(sqlx::query_scalar::<_,Value>(&query).fetch_optional(&f.db).await.unwrap().is_some());
            for revoke in [
                "UPDATE storefront_themes SET status='REVOKED' WHERE id='grocery'",
                "UPDATE customer_accounts SET disabled=true",
                "UPDATE tenants SET management_state='SUSPENDED'",
                "UPDATE provisioning_jobs SET status='FAILED',lease_token=NULL,lease_until=NULL",
            ] {
                let mut tx = f.db.begin().await.unwrap();
                sqlx::query(revoke).execute(&mut *tx).await.unwrap();
                assert!(sqlx::query_scalar::<_,Value>(&query).fetch_optional(&mut *tx).await.unwrap().is_none(), "{provider}: {revoke}");
                tx.rollback().await.unwrap();
            }
        }
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL; see README.md"]
async fn fleet_staff_selected_host_never_overflows_or_falls_back() {
    database_test(|base| async move {
        let f=base.with_billing();
        f.customer("host-owner@example.test",true).await;
        let owner=staff_token(&f,"host-owner@example.test","OWNER").await;
        let host=Uuid::new_v4();
        sqlx::query("INSERT INTO merchant_hosts(id,provider,state,profile_digest,release_digest) VALUES($1,'aws','READY',$2,$3)")
            .bind(host).bind("b".repeat(64)).bind(format!("sha256:{}","a".repeat(64))).execute(&f.db).await.unwrap();
        let mut jobs=Vec::new();
        for n in 0..4 {
            let (_,p)=paid_fixture(&f,&format!("selected-{n}")).await;
            let tenant=Uuid::parse_str(p["tenantId"].as_str().unwrap()).unwrap();
            let path=format!("/staff/stores/{tenant}/hosting");
            assert_eq!(f.call("POST",&path,Some(&owner),json!({"provider":"gcp","hostId":host})).await.0,409);
            assert_eq!(f.ok("POST",&path,Some(&owner),json!({"provider":"aws","hostId":host})).await["hostId"],json!(host));
            provisioning::ingest(&f.db).await.unwrap();
            let j=provisioning::claim(&f.db).await.unwrap().unwrap();
            sqlx::query("UPDATE provisioning_jobs SET artifact_digest=$1,release_version='fixture-v1' WHERE id=$2").bind(format!("sha256:{}","a".repeat(64))).bind(j.id).execute(&f.db).await.unwrap();
            jobs.push(j);
        }
        // A selected host with the wrong release/profile cannot trigger another VM.
        let unavailable:Option<Value>=sqlx::query_scalar("SELECT reserve_merchant_host($1,$2,$3,20,$4)")
            .bind(jobs[0].id).bind(jobs[0].lease_token).bind("c".repeat(64)).bind(Uuid::new_v4()).fetch_one(&f.db).await.unwrap();
        assert!(unavailable.is_none());
        let mut tasks=Vec::new();
        for j in jobs { let db=f.db.clone();tasks.push(tokio::spawn(async move {
            sqlx::query_scalar::<_,Option<Value>>("SELECT reserve_merchant_host($1,$2,$3,20,$4)")
                .bind(j.id).bind(j.lease_token).bind("b".repeat(64)).bind(Uuid::new_v4()).fetch_one(&db).await.unwrap()
        })); }
        let mut placed=0;
        for task in tasks {if let Some(p)=task.await.unwrap(){assert_eq!(p["id"],json!(host));placed+=1;}}
        assert_eq!(placed,3);
        assert_eq!(f.count("SELECT count(*) FROM merchant_hosts").await,1);
        let (_,p)=paid_fixture(&f,"selected-full").await;
        let path=format!("/staff/stores/{}/hosting",p["tenantId"].as_str().unwrap());
        assert_eq!(f.call("POST",&path,Some(&owner),json!({"provider":"aws","hostId":host})).await.0,409);
        let detail=f.ok("GET",path.trim_end_matches("/hosting"),Some(&owner),Value::Null).await;
        assert_eq!(detail["hosts"][0]["usedSlots"],3);
        assert_eq!(detail["hosts"][0]["maxSlots"],3);
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn offline_codes_are_owned_limited_and_calendar_billed() {
 database_test(|base| async move {
    let f=base.with_billing();
    let token=f.customer("code@example.test",true).await;
    let other=f.customer("other-code@example.test",true).await;
    let owner=staff_token(&f,"code@example.test","OWNER").await;
    let draft=f.draft(&token,"calendar-store").await;
    assert_eq!(f.reserve(&token,&draft).await.0,200);
    let request=format!("/onboarding/drafts/{}/payment-request",draft["id"].as_str().unwrap());
    assert_eq!(f.call("POST",&request,Some(&token),json!({"serviceMonths":2})).await.0,400);
    let payment=f.ok("POST",&request,Some(&token),json!({"serviceMonths":12})).await;
    assert_eq!(payment["amountMinor"],94800); assert_eq!(payment["serviceMonths"],12);
    let issue=format!("/staff/payments/{}/confirm",payment["id"].as_str().unwrap());
    let body=json!({"receiptReference":"annual-receipt","amountMinor":94800,"currency":"USD","serviceDays":360});
    let issued=f.ok("POST",&issue,Some(&owner),body.clone()).await;
    let code=issued["code"].as_str().unwrap(); assert_eq!(code.len(),6);
    assert_eq!(f.count("SELECT count(*) FROM billing_entitlements").await,0);
    let redeem=format!("/billing/payment-requests/{}/redeem",payment["id"].as_str().unwrap());
    assert_eq!(f.call("POST",&redeem,Some(&other),json!({"code":code})).await.0,404);
    let wrong=if code=="000000" {"111111"} else {"000000"};
    for _ in 0..5 { assert_eq!(f.call("POST",&redeem,Some(&token),json!({"code":wrong})).await.0,400); }
    assert_eq!(f.call("POST",&redeem,Some(&token),json!({"code":code})).await.1["code"],"PAYMENT_CODE_LOCKED");
    sqlx::query("UPDATE payment_codes SET issued_at=clock_timestamp()-interval '61 seconds'").execute(&f.db).await.unwrap();
    let replacement=f.ok("POST",&issue,Some(&owner),body).await;
    let (a,b)=tokio::join!(f.call("POST",&redeem,Some(&token),json!({"code":replacement["code"]})),f.call("POST",&redeem,Some(&token),json!({"code":replacement["code"]})));
    assert_eq!(a.0,200,"{a:?}"); assert_eq!(b.0,200,"{b:?}");
    assert_eq!(f.count("SELECT count(*) FROM billing_entitlements WHERE service_months=12").await,1);
    assert_eq!(f.count("SELECT count(*) FROM payment_confirmations").await,1);
    let ends:String=sqlx::query_scalar("SELECT (date '2028-02-29'+service_months*interval '1 month')::date::text FROM billing_entitlements").fetch_one(&f.db).await.unwrap();
    assert_eq!(ends,"2029-02-28");
 }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn approved_prices_cover_all_plans_and_periods() {
 database_test(|f| async move {
    for (plan,monthly) in [("STARTER",2900i64),("LAUNCH",7900),("GROWTH",30000),("ENTERPRISE",250000)] {
      for months in [1,12] {
        let slug=format!("{}-{months}",plan.to_lowercase());
        let token=f.customer(&format!("{slug}@example.test"),true).await;
        let draft=f.draft(&token,&slug).await;
        let id=Uuid::parse_str(draft["id"].as_str().unwrap()).unwrap();
        sqlx::query("UPDATE onboarding_drafts SET plan=$2 WHERE id=$1").bind(id).bind(plan).execute(&f.db).await.unwrap();
        assert_eq!(f.reserve(&token,&draft).await.0,200);
        let payment=f.ok("POST",&format!("/onboarding/drafts/{id}/payment-request"),Some(&token),json!({"serviceMonths":months})).await;
        assert_eq!(payment["amountMinor"],monthly*months);
        assert_eq!(payment["currency"],"USD");
        assert_eq!(payment["serviceMonths"],months);
      }
    }
 }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn checkpoint_reconciliation_commits_once_after_lost_response() {
    struct LostResponse(std::sync::atomic::AtomicUsize);
    impl Executor for LostResponse {
        async fn execute(&self, _: &Job) -> Result<Evidence, Failure> {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Err(Failure::Review("EXECUTOR_FAILED"))
        }
        async fn reconcile(&self, job: &Job) -> Result<Evidence, Failure> { Ok(evidence(job)) }
    }
    database_test(|base| async move {
        let f = base.with_billing();
        paid_fixture(&f, "lost-response").await;
        approve_fixture(&f.db).await;
        let executor = LostResponse(std::sync::atomic::AtomicUsize::new(0));
        provisioning::run_once(&f.db, &executor).await.unwrap();
        assert_eq!(executor.0.load(std::sync::atomic::Ordering::SeqCst), 1);
        assert_eq!(f.count("SELECT count(*) FROM provisioning_steps WHERE step='RELEASE'").await, 1);
        assert_eq!(f.count("SELECT count(*) FROM provisioning_jobs WHERE step='ALLOCATE' AND status='QUEUED'").await, 1);
        assert_eq!(f.count("SELECT count(*) FROM billing_entitlements WHERE starts_at IS NOT NULL").await, 0);
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn independent_jobs_execute_concurrently_without_duplicate_claims() {
    struct Concurrent(tokio::sync::Barrier);
    impl Executor for Concurrent {
        async fn execute(&self, job: &Job) -> Result<Evidence, Failure> {
            tokio::time::timeout(Duration::from_secs(5), self.0.wait()).await.unwrap();
            Ok(evidence(job))
        }
    }
    database_test(|base| async move {
        let f = base.with_billing();
        paid_fixture(&f, "parallel-first").await;
        paid_fixture(&f, "parallel-second").await;
        approve_fixture(&f.db).await;
        provisioning::ingest(&f.db).await.unwrap();
        let executor = Concurrent(tokio::sync::Barrier::new(2));
        let (a, b) = tokio::join!(provisioning::run_once(&f.db, &executor), provisioning::run_once(&f.db, &executor));
        assert!(a.unwrap() && b.unwrap());
        assert_eq!(f.count("SELECT count(*) FROM provisioning_steps WHERE step='RELEASE'").await, 2);
        assert_eq!(f.count("SELECT count(*) FROM provisioning_jobs WHERE step='ALLOCATE' AND status='QUEUED'").await, 2);
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn checkpoint_migration_requires_drain_and_preserves_existing_evidence() {
    database_test(|base| async move {
        let f = base.with_billing();
        paid_fixture(&f, "checkpoint-upgrade").await;
        approve_fixture(&f.db).await;
        for _ in 0..2 { provisioning::run_once(&f.db, &GoodExecutor).await.unwrap(); }
        let mut tx = f.db.begin().await.unwrap();
        sqlx::Executor::execute(&mut *tx, "ALTER TABLE provisioning_jobs DROP CONSTRAINT provisioning_jobs_step_check; UPDATE provisioning_jobs SET step='DEPLOY'; ALTER TABLE provisioning_jobs ADD CONSTRAINT provisioning_jobs_step_check CHECK(step IN ('RELEASE','ALLOCATE','DEPLOY','VALIDATE','DONE'));").await.unwrap();
        sqlx::Executor::execute(&mut *tx, include_str!("../database/migrations/011_provisioning_checkpoints.sql")).await.unwrap();
        let step: String = sqlx::query_scalar("SELECT step FROM provisioning_jobs").fetch_one(&mut *tx).await.unwrap();
        assert_eq!(step, "DATABASE");
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM provisioning_steps").fetch_one(&mut *tx).await.unwrap();
        assert_eq!(count, 2);
        tx.rollback().await.unwrap();
        provisioning::claim(&f.db).await.unwrap().unwrap();
        let mut tx = f.db.begin().await.unwrap();
        let error = sqlx::Executor::execute(&mut *tx, include_str!("../database/migrations/011_provisioning_checkpoints.sql")).await.unwrap_err();
        assert!(error.to_string().contains("PROVISIONING_WORKER_MUST_BE_DRAINED"));
        tx.rollback().await.unwrap();
        assert_eq!(f.count("SELECT count(*) FROM provisioning_jobs WHERE step='DATABASE' AND status='RUNNING'").await, 1);
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn legacy_completed_deploy_can_validate_but_new_checkpoints_cannot_be_skipped() {
    database_test(|base| async move {
        let f = base.with_billing();
        paid_fixture(&f, "legacy-validation").await;
        approve_fixture(&f.db).await;
        for _ in 0..2 { provisioning::run_once(&f.db, &GoodExecutor).await.unwrap(); }
        sqlx::Executor::execute(&f.db, "INSERT INTO provisioning_steps(job_id,step,evidence) SELECT id,'DEPLOY','{}'::jsonb FROM provisioning_jobs; UPDATE provisioning_jobs SET step='VALIDATE'; UPDATE tenants SET lifecycle_status='VALIDATING';").await.unwrap();
        provisioning::run_once(&f.db, &GoodExecutor).await.unwrap();
        assert_eq!(f.count("SELECT count(*) FROM tenants WHERE lifecycle_status='ACTIVE'").await, 1);
    }).await;
    database_test(|base| async move {
        let f = base.with_billing();
        paid_fixture(&f, "skipped-checkpoint").await;
        approve_fixture(&f.db).await;
        for _ in 0..2 { provisioning::run_once(&f.db, &GoodExecutor).await.unwrap(); }
        sqlx::query("UPDATE provisioning_jobs SET step='INGRESS'").execute(&f.db).await.unwrap();
        provisioning::run_once(&f.db, &GoodExecutor).await.unwrap();
        assert_eq!(f.count("SELECT count(*) FROM provisioning_jobs WHERE last_error='STEP_ORDER_INVALID' AND status='FAILED'").await, 1);
        assert_eq!(f.count("SELECT count(*) FROM billing_entitlements WHERE starts_at IS NOT NULL").await, 0);
    }).await;
}

#[tokio::test]
#[ignore = "requires disposable PostgreSQL"]
async fn staff_store_detail_reports_current_job_without_dashboard_lookup() {
    database_test(|base| async move {
        let f = base.with_billing();
        f.customer("setup-staff@example.test", true).await;
        let owner = staff_token(&f, "setup-staff@example.test", "OWNER").await;
        let (_, payment) = paid_fixture(&f, "setup-details").await;
        let path = format!("/staff/stores/{}", payment["tenantId"].as_str().unwrap());
        let pending = f.ok("GET", &path, Some(&owner), Value::Null).await;
        assert!(pending["job"].is_null());
        provisioning::ingest(&f.db).await.unwrap();
        provisioning::run_once(&f.db, &GoodExecutor).await.unwrap();
        let detail = f.ok("GET", &path, Some(&owner), Value::Null).await;
        assert_eq!(detail["job"]["tenantId"], payment["tenantId"]);
        assert_eq!(detail["job"]["status"], "BLOCKED");
        assert_eq!(detail["job"]["step"], "RELEASE");
        assert_eq!(detail["job"]["reason"], "APPROVED_RELEASE_REQUIRED");
        assert!(detail["steps"].as_array().unwrap().is_empty());
    }).await;
}
