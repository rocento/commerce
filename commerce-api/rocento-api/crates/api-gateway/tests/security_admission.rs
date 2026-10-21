mod support;

use api_gateway::{auth_ip::AuthIpRateLimit, identity::App};
use axum::{body::Body, extract::ConnectInfo, http::Request, Router};
use serde_json::{json, Value};
use sqlx::PgPool;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use tower::ServiceExt;
use uuid::Uuid;

async fn app(pool: PgPool) -> App {
    infra_auth::password::configure(infra_auth::password::PasswordHashConfig {
        max_concurrency: 2,
        wait_timeout: std::time::Duration::from_secs(5),
    })
    .unwrap();
    let security = infra_auth::Security::new(
        "security-admission-fixture-".repeat(3),
        "http://localhost".into(),
        false,
    )
    .await
    .unwrap();
    App::new(pool, security, vec![])
}
async fn post(router: &Router, path: &str, cookie: &str, peer: &str, body: Value) -> u16 {
    let request = Request::builder()
        .method("POST")
        .uri(path)
        .header("content-type", "application/json")
        .header("x-commerce-request", "1")
        .header("cookie", cookie)
        .header("x-forwarded-for", Uuid::new_v4().to_string())
        .header("cf-connecting-ip", "203.0.113.99")
        .extension(ConnectInfo(peer.parse::<std::net::SocketAddr>().unwrap()))
        .body(Body::from(body.to_string()))
        .unwrap();
    router
        .clone()
        .oneshot(request)
        .await
        .unwrap()
        .status()
        .as_u16()
}
fn invalid_ticket() -> Value {
    json!({"request_id":Uuid::new_v4(),"subject":"","category":"other","body":"Review","order_id":null,"contact_name":"Review","contact":"review@example.test"})
}
fn guest(name: &str, character: char) -> String {
    format!("{name}={}", character.to_string().repeat(48))
}

#[sqlx::test(migrations = "../../migrations")]
async fn guest_exhaustion_is_isolated_and_cookie_rotation_is_source_bounded_across_replicas(
    pool: PgPool,
) {
    let mut identity = app(pool.clone()).await;
    identity.public_admission.support.subject = 2;
    identity.public_admission.support.source = 4;
    identity.public_admission.support.aggregate = 12;
    let tenant = Uuid::new_v4();
    let router = api_gateway::support::router(api_gateway::support::App {
        identity: identity.clone(),
        tenant,
    });
    // A separate router has no shared process limiter state: PostgreSQL owns admission.
    let replica = api_gateway::support::router(api_gateway::support::App { identity, tenant });
    for _ in 0..2 {
        assert_eq!(
            post(
                &router,
                "/v1/support/tickets",
                &guest("support_guest", 'a'),
                "198.51.100.1:1000",
                invalid_ticket()
            )
            .await,
            400
        );
    }
    for _ in 0..10 {
        assert_eq!(
            post(
                &replica,
                "/v1/support/tickets",
                &guest("support_guest", 'a'),
                "198.51.100.1:2000",
                invalid_ticket()
            )
            .await,
            429
        );
    }
    assert_eq!(
        post(
            &replica,
            "/v1/support/tickets",
            &guest("support_guest", 'b'),
            "198.51.100.2:1000",
            invalid_ticket()
        )
        .await,
        400
    );
    for _ in 0..2 {
        assert_eq!(
            post(
                &replica,
                "/v1/support/tickets",
                &guest("support_guest", 'c'),
                "198.51.100.1:3000",
                invalid_ticket()
            )
            .await,
            400
        );
    }
    assert_eq!(
        post(
            &router,
            "/v1/support/tickets",
            &guest("support_guest", 'd'),
            "198.51.100.1:4000",
            invalid_ticket()
        )
        .await,
        429
    );
    let admitted: i32 =
        sqlx::query_scalar("SELECT attempts FROM platform.rate_limits WHERE key=$1")
            .bind(infra_auth::digest("public:support:installation"))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        admitted, 5,
        "rejected clients must not burn the shared allowance"
    );
    let tickets: i64 = sqlx::query_scalar("SELECT count(*) FROM support.tickets")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(tickets, 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn installation_budget_is_shared_and_ingress_avoids_a_shared_docker_peer_bucket(
    pool: PgPool,
) {
    let mut identity = app(pool.clone()).await;
    identity.auth_ip_rate_limit = AuthIpRateLimit::Ingress;
    identity.public_admission.support.subject = 1;
    identity.public_admission.support.source = 1;
    identity.public_admission.support.aggregate = 3;
    let tenant = Uuid::new_v4();
    let router = api_gateway::support::router(api_gateway::support::App {
        identity: identity.clone(),
        tenant,
    });
    let replica = api_gateway::support::router(api_gateway::support::App { identity, tenant });
    for character in ['a', 'b', 'c'] {
        assert_eq!(
            post(
                &router,
                "/v1/support/tickets",
                &guest("support_guest", character),
                "172.18.0.1:1000",
                invalid_ticket()
            )
            .await,
            400
        );
    }
    assert_eq!(
        post(
            &replica,
            "/v1/support/tickets",
            &guest("support_guest", 'd'),
            "172.18.0.1:1000",
            invalid_ticket()
        )
        .await,
        429
    );
    let peer: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM platform.rate_limits WHERE key=$1)")
            .bind(infra_auth::digest("public:support:source:172.18.0.1"))
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        !peer,
        "managed ingress enforces source quotas before Docker NAT"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn anonymous_analytics_is_limited_before_clickhouse_writes(pool: PgPool) {
    let writes = Arc::new(AtomicUsize::new(0));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let counter = writes.clone();
    let mock = Router::new().route(
        "/",
        axum::routing::post(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                ""
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, mock).await.unwrap() });
    let mut identity = app(pool.clone()).await;
    identity.public_admission.analytics.subject = 2;
    identity.public_admission.analytics.source = 3;
    identity.public_admission.analytics.aggregate = 4;
    let catalog = api_gateway::catalog::App {
        identity,
        catalog: domain_catalog::Service { pool: pool.clone() },
        search: domain_search_client::Client::new(endpoint.clone(), "unused".into()),
        media: infra_media::Store::new(endpoint.clone(), "unused", "unused").unwrap(),
        analytics: api_gateway::analytics::Client::new(endpoint, "unused".into(), "unused".into()),
    };
    let router = api_gateway::catalog::router(catalog.clone());
    let replica = api_gateway::catalog::router(catalog);
    let event = || json!({"id":Uuid::new_v4(),"session_id":Uuid::new_v4(),"event_type":"page_view","path":"/","source":"direct"});
    for _ in 0..2 {
        assert_eq!(
            post(
                &router,
                "/v1/analytics/events",
                &guest("analytics_visitor", 'a'),
                "198.51.100.1:1000",
                event()
            )
            .await,
            201
        );
    }
    assert_eq!(
        post(
            &replica,
            "/v1/analytics/events",
            &guest("analytics_visitor", 'a'),
            "198.51.100.1:1000",
            event()
        )
        .await,
        429
    );
    assert_eq!(
        post(
            &replica,
            "/v1/analytics/events",
            &guest("analytics_visitor", 'b'),
            "198.51.100.1:1000",
            event()
        )
        .await,
        201
    );
    assert_eq!(
        post(
            &router,
            "/v1/analytics/events",
            &guest("analytics_visitor", 'c'),
            "198.51.100.1:1000",
            event()
        )
        .await,
        429
    );
    assert_eq!(
        post(
            &replica,
            "/v1/analytics/events",
            &guest("analytics_visitor", 'd'),
            "198.51.100.2:1000",
            event()
        )
        .await,
        201
    );
    assert_eq!(
        post(
            &router,
            "/v1/analytics/events",
            &guest("analytics_visitor", 'e'),
            "198.51.100.3:1000",
            event()
        )
        .await,
        429
    );
    assert_eq!(
        writes.load(Ordering::SeqCst),
        8,
        "four admitted page views perform two writes each; rejected requests write nothing"
    );
    server.abort();
}

#[sqlx::test(migrations = "../../migrations")]
async fn support_only_roles_can_work_tickets_without_unrelated_admin_access(pool: PgPool) {
    let identity = app(pool.clone()).await;
    let password = "Strong fixture password!";
    identity
        .admins
        .seed("owner@example.test", password.into())
        .await
        .unwrap();
    let (owner, _) = identity
        .admins
        .login(domain_admin_iam::Credentials {
            email: "owner@example.test".into(),
            password: password.into(),
        })
        .await
        .unwrap();
    let role = identity
        .admins
        .save_role(
            &owner,
            None,
            domain_admin_iam::RoleInput {
                name: "Support operator".into(),
                permissions: vec!["support.read".into(), "support.write".into()],
            },
        )
        .await
        .unwrap();
    identity
        .admins
        .save_user(
            &owner,
            None,
            domain_admin_iam::UserInput {
                email: "support@example.test".into(),
                name: "Support".into(),
                role_id: role.id,
                password: Some(password.into()),
                active: true,
            },
        )
        .await
        .unwrap();
    let (operator, _) = identity
        .admins
        .login(domain_admin_iam::Credentials {
            email: "support@example.test".into(),
            password: password.into(),
        })
        .await
        .unwrap();
    let service = domain_support::Service {
        pool: pool.clone(),
        tenant: Uuid::new_v4(),
    };
    let ticket = service
        .create(
            &domain_support::Actor::Guest("fixture"),
            &domain_support::TicketInput {
                request_id: Uuid::new_v4(),
                subject: "Help".into(),
                category: "other".into(),
                body: "Please help".into(),
                order_id: None,
                contact_name: Some("Fixture".into()),
                contact: Some("fixture@example.test".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(
        service
            .list(&domain_support::Actor::Admin(&operator))
            .await
            .unwrap()
            .len(),
        1
    );
    service
        .reply(
            ticket.ticket.id,
            &domain_support::Actor::Admin(&operator),
            &domain_support::Reply {
                request_id: Uuid::new_v4(),
                body: "We can help".into(),
                status: Some("in_progress".into()),
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        identity.admins.users(&operator).await,
        Err(infra_auth::Error::Forbidden)
    ));
    assert!(operator.require("orders.read").is_err());
    let read_only = identity
        .admins
        .save_role(
            &owner,
            Some(role.id),
            domain_admin_iam::RoleInput {
                name: "Support operator".into(),
                permissions: vec!["support.read".into()],
            },
        )
        .await
        .unwrap();
    assert_eq!(read_only.permissions.len(), 1);
    let (reader, _) = identity
        .admins
        .login(domain_admin_iam::Credentials {
            email: "support@example.test".into(),
            password: password.into(),
        })
        .await
        .unwrap();
    assert!(service
        .detail(ticket.ticket.id, &domain_support::Actor::Admin(&reader))
        .await
        .is_ok());
    assert!(matches!(
        service
            .reply(
                ticket.ticket.id,
                &domain_support::Actor::Admin(&reader),
                &domain_support::Reply {
                    request_id: Uuid::new_v4(),
                    body: "Not allowed".into(),
                    status: None
                }
            )
            .await,
        Err(infra_auth::Error::Forbidden)
    ));
}

#[sqlx::test(migrations = "../../migrations")]
async fn assistant_guest_allowance_is_individual_and_issued_cookie_is_http_only(pool: PgPool) {
    let identity = app(pool.clone()).await;
    let configured = api_gateway::assistant::App {
        identity: identity.clone(),
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
    let router = api_gateway::assistant::router(identity, Some(configured));
    let input = || json!({"request_id":Uuid::new_v4(),"message":""});
    // Exercise the real shopping-chat default, including requests beyond the
    // former 30-turn cap, without calling an AI provider.
    for _ in 0..120 {
        assert_eq!(
            post(
                &router,
                "/v1/assistant/chat",
                &guest("assistant_visitor", 'a'),
                "198.51.100.1:1000",
                input()
            )
            .await,
            400
        );
    }
    assert_eq!(
        post(
            &router,
            "/v1/assistant/chat",
            &guest("assistant_visitor", 'a'),
            "198.51.100.1:1000",
            input()
        )
        .await,
        429
    );
    assert_eq!(
        post(
            &router,
            "/v1/assistant/chat",
            &guest("assistant_visitor", 'b'),
            "198.51.100.1:2000",
            input()
        )
        .await,
        400
    );
    let response = router
        .oneshot(
            Request::post("/v1/assistant/chat")
                .header("content-type", "application/json")
                .header("x-commerce-request", "1")
                .body(Body::from(input().to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 400);
    let cookie = response.headers()["set-cookie"].to_str().unwrap();
    assert!(cookie.starts_with("assistant_visitor="));
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Strict"));
}
