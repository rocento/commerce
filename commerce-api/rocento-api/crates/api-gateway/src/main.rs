#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = api_gateway::config::StartupConfig::from_environment()?;
    let request_budget = api_gateway::request_budget::Budget::from_environment()?;
    infra_auth::password::configure(config.password_hash)?;
    let mailpit = config
        .security
        .as_ref()
        .filter(|security| security.notification_mode == "mailpit")
        .map(|security| {
            api_gateway::notifications::Mailpit::new_with_storefront(
                &std::env::var("MAILPIT_URL").unwrap_or_else(|_| "http://127.0.0.1:8025".into()),
                &std::env::var("NOTIFICATION_FROM")
                    .unwrap_or_else(|_| "commerce@example.test".into()),
                &security.storefront_url,
            )
        })
        .transpose()?;
    let smtp = config
        .security
        .as_ref()
        .filter(|security| security.notification_mode == "smtp")
        .map(|_| api_gateway::notifications::Smtp::from_env())
        .transpose()?;
    let push = api_gateway::order_push::Provider::from_environment()?;
    let telemetry = infra_observability::init();
    infra_observability::start_log_shipping();
    // Keep the pool alive for the lifetime of the service. Startup fails on migration errors.
    let pool = if let Some(url) = &config.database_url {
        let pool = infra_db::connect(url).await?;
        infra_db::migrate(&pool).await?;
        Some(pool)
    } else {
        tracing::warn!("DATABASE_URL is unset; running liveness-only gateway");
        None
    };
    let address = config.bind_address;
    let listener = tokio::net::TcpListener::bind(&address).await?;
    tracing::info!(%address, "gateway listening");
    let mut workers = api_gateway::workers::Supervisor::default();
    let mut router = api_gateway::router_with_worker_readiness(pool.clone(), workers.health());
    if let Some(pool) = pool.clone() {
        let settings = config
            .security
            .expect("database configuration requires security settings");
        let publication =
            api_gateway::public_commerce::policy::Deployment::from_environment(&pool).await?;
        let mut security = infra_auth::Security::new(
            settings.auth_secret,
            settings.storefront_url,
            settings.secure_cookies,
        )
        .await?;
        if let Some(transport) = mailpit {
            security.queued_notifications = true;
            workers.spawn(
                "notifications",
                api_gateway::notifications::worker(pool.clone(), transport),
            );
        }
        if let Some(transport) = smtp {
            security.queued_notifications = true;
            security.email_notifications_only = true;
            workers.spawn(
                "notifications",
                api_gateway::notifications::worker(pool.clone(), transport),
            );
        }
        if let Some(provider) = &push {
            workers.spawn(
                "order-push",
                api_gateway::order_push::worker(pool.clone(), provider.clone()),
            );
        }
        if let Ok(url) = std::env::var("NATS_URL") {
            workers.spawn("outbox", infra_events::publisher(pool.clone(), url));
        }
        let mut identity =
            api_gateway::identity::App::new(pool.clone(), security, settings.origins);
        if let Ok(url) = std::env::var("ENGAGEMENT_DATABASE_URL") {
            let engagement = api_gateway::engagement::connect(&url, 6).await?;
            api_gateway::engagement::migrate(&engagement).await?;
            api_gateway::engagement::import(&pool, &engagement).await?;
            identity.engagement = engagement;
            identity.engagement_isolated = true;
            // Low-volume admin journey reads cannot exhaust checkout's pool.
            identity.engagement_commerce =
                api_gateway::engagement::connect(config.database_url.as_deref().unwrap(), 2)
                    .await?;
        } else if std::env::var("APP_ENV").as_deref() == Ok("production") {
            return Err("ENGAGEMENT_DATABASE_URL is required in production".into());
        }
        identity.auth_ip_rate_limit = settings.auth_ip_rate_limit;
        identity.public_admission = settings.public_admission;
        workers.spawn(
            "authentication-retention",
            infra_auth::retention::worker(pool.clone()),
        );
        let ttl = std::env::var("RESERVATION_TTL_SECONDS")
            .unwrap_or_else(|_| "900".into())
            .parse()?;
        identity.cart.inventory = domain_inventory::Service::new(pool.clone(), ttl)?;
        workers.spawn("inventory-expiry", identity.cart.inventory.clone().worker());
        workers.spawn(
            "capacity-expiry",
            domain_fulfillment::capacity::Service { pool: pool.clone() }.worker(),
        );
        let catalog = domain_catalog::Service { pool };
        let search = domain_search_client::Client::serving_environment()?;
        let media = infra_media::Store::new(
            std::env::var("S3_ENDPOINT")?,
            &std::env::var("S3_ACCESS_KEY")?,
            &std::env::var("S3_SECRET_KEY")?,
        )
        .map_err(|e| e.to_string())?;
        media.initialize().await.map_err(|e| e.to_string())?;
        let analytics = api_gateway::analytics::Client::new(
            std::env::var("CLICKHOUSE_URL")?,
            std::env::var("CLICKHOUSE_USER")?,
            std::env::var("CLICKHOUSE_PASSWORD")?,
        );
        router = router.merge(api_gateway::order_push::router(
            identity.clone(),
            push.clone(),
        ));
        router = router.merge(api_gateway::reporting::router(
            api_gateway::reporting::App {
                identity: identity.clone(),
                analytics: analytics.clone(),
            },
        ));
        workers.spawn(
            "order-confirmations",
            api_gateway::commerce_notifications::Consumer::Orders.run(
                identity.customers.pool.clone(),
                std::env::var("NATS_URL")?,
                settings.notification_mode.clone(),
            ),
        );
        workers.spawn(
            "shipment-notifications",
            api_gateway::commerce_notifications::Consumer::LegacyShipments.run(
                identity.customers.pool.clone(),
                std::env::var("NATS_URL")?,
                settings.notification_mode.clone(),
            ),
        );
        workers.spawn(
            "shipment-dispatch-notifications",
            api_gateway::commerce_notifications::Consumer::ShipmentDispatches.run(
                identity.customers.pool.clone(),
                std::env::var("NATS_URL")?,
                settings.notification_mode,
            ),
        );
        workers.spawn(
            "search-index",
            domain_search_client::consume(
                catalog.clone(),
                identity.cart.inventory.clone(),
                domain_search_client::Client::new(
                    std::env::var("MEILI_URL")?,
                    std::env::var("MEILI_MASTER_KEY")?,
                ),
                std::env::var("NATS_URL")?,
            ),
        );
        // Provisioned infrastructure keeps admin settings reachable even when
        // conversations are switched off. The saved admin setting controls chat.
        let assistant = match api_gateway::assistant::App::environment(identity.clone()) {
            Ok(app) => Some(app),
            Err(_) => {
                tracing::warn!("Assistant infrastructure is not configured");
                None
            }
        };
        workers.spawn(
            "account-deletion",
            api_gateway::account_deletion::worker(
                identity.clone(),
                assistant.clone(),
                analytics.clone(),
            ),
        );
        if let Ok(tenant) = std::env::var("ASSISTANT_TENANT_ID") {
            let tenant = tenant.parse::<uuid::Uuid>()?;
            router = router.merge(api_gateway::support::router(api_gateway::support::App {
                identity: identity.clone(),
                tenant,
            }));
        }
        workers.spawn(
            "publication-maintenance",
            api_gateway::public_commerce::health::maintenance(identity.admins.pool.clone()),
        );
        workers.spawn(
            "publication-feeds",
            api_gateway::public_commerce::feeds::worker(api_gateway::discoverability::App {
                identity: identity.clone(),
                deployment: publication.clone(),
            }),
        );
        router = router
            .merge(api_gateway::identity::router(identity.clone()))
            .merge(api_gateway::account_deletion::router(identity.clone()))
            .merge(api_gateway::api_reference::router(identity.clone()))
            .merge(api_gateway::email_templates::router(identity.clone()))
            .merge(api_gateway::marketing_notifications::router(
                identity.clone(),
            ))
            .merge(api_gateway::storefront_notifications::router(
                identity.clone(),
            ))
            .merge(api_gateway::assistant::router(identity.clone(), assistant))
            .merge(api_gateway::discoverability::router_with_deployment(
                identity.clone(),
                publication.clone(),
            ))
            .merge(api_gateway::merchant::router(identity.clone()))
            .merge(api_gateway::mobile::router_with_media(
                identity.clone(),
                Some(media.clone()),
            ))
            .merge(api_gateway::cart::router(identity.clone()))
            .merge(api_gateway::orders::router(identity.clone()))
            .merge(api_gateway::admin_depth::router(identity.clone()))
            .merge(api_gateway::themes::router_with_deployment(
                identity.clone(),
                publication,
            ))
            .merge(api_gateway::localization::router(identity.clone()))
            .merge(api_gateway::localization::public_router(identity.clone()))
            .merge(api_gateway::attributes::router(identity.clone()))
            .merge(api_gateway::segments::router(identity.clone()))
            .merge(api_gateway::relationships::router(identity.clone()))
            .merge(api_gateway::replenishment::router(
                api_gateway::replenishment::App {
                    identity: identity.clone(),
                    pool: catalog.pool.clone(),
                },
            ))
            .merge(api_gateway::grids::router(identity.clone()))
            .merge(api_gateway::exports::router(identity.clone()))
            .merge(api_gateway::catalog::router(api_gateway::catalog::App {
                identity,
                catalog,
                search,
                media,
                analytics,
            }));
    }
    router = router
        .route(
            "/metrics",
            axum::routing::get({
                let pool = pool.clone();
                let reliability = pool.as_ref().map(api_gateway::reliability::Collector::new);
                move || {
                    let pool = pool.clone();
                    let reliability = reliability.clone();
                    async move {
                        if let Some(pool) = pool {
                            infra_observability::record_db_pool_snapshot(infra_db::pool_snapshot(
                                &pool,
                            ));
                        }
                        let (headers, mut metrics) = infra_observability::metrics().await;
                        if let Some(collector) = reliability {
                            collector.append_metrics(&mut metrics).await;
                        }
                        let retention = infra_auth::retention::status();
                        metrics.push_str(&format!(
                            "# TYPE commerce_auth_retention_last_success_seconds gauge\ncommerce_auth_retention_last_success_seconds {}\n# TYPE commerce_auth_retention_failures_total counter\ncommerce_auth_retention_failures_total {}\n# TYPE commerce_auth_retention_oldest_due_seconds gauge\ncommerce_auth_retention_oldest_due_seconds {}\n",
                            retention.last_success_unix, retention.failures, retention.oldest_due_seconds,
                        ));
                        (headers, metrics)
                    }
                }
            }),
        );
    router = router.layer(axum::middleware::from_fn_with_state(
        request_budget,
        api_gateway::request_budget::enforce,
    ));
    router = router.layer(axum::middleware::from_fn(
        infra_observability::request_trace,
    ));
    router = router.layer(axum::middleware::from_fn(
        api_gateway::public_commerce::policy::api_headers,
    ));
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let server = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<std::net::SocketAddr>(),
    )
    .with_graceful_shutdown(async {
        let _ = shutdown_rx.await;
    });
    let server = std::future::IntoFuture::into_future(server);
    tokio::pin!(server);
    enum Stop {
        Server(std::io::Result<()>),
        Signal(std::io::Result<()>),
        Worker(api_gateway::workers::Failure),
    }
    let stop = tokio::select! {
        result = &mut server => Stop::Server(result),
        result = shutdown_signal() => Stop::Signal(result),
        Some(failure) = workers.next_failure(), if !workers.is_empty() => Stop::Worker(failure),
    };
    // Keep cleanup common to all exit paths, including server/signal errors.
    let result: Result<(), Box<dyn std::error::Error>> = match stop {
        Stop::Server(result) => result.map_err(Into::into),
        reason => {
            workers.begin_shutdown();
            let failure: Result<(), Box<dyn std::error::Error>> = match reason {
                Stop::Signal(result) => result.map_err(Into::into),
                Stop::Worker(failure) => {
                    tracing::error!(worker=failure.name,reason=?failure.reason,"background worker exited unexpectedly; shutting down");
                    Err(Box::new(failure))
                }
                Stop::Server(_) => unreachable!(),
            };
            tracing::info!("shutdown requested; draining requests for up to 30 seconds");
            let _ = shutdown_tx.send(());
            let drained =
                match tokio::time::timeout(std::time::Duration::from_secs(30), &mut server).await {
                    Ok(result) => result.map_err(Into::into),
                    Err(_) => {
                        tracing::warn!(
                        "request drain deadline exceeded; unfinished transactions will roll back"
                    );
                        Ok(())
                    }
                };
            failure.and(drained)
        }
    };
    // Cancel background work before closing pools so workers cannot keep acquiring
    // connections during shutdown. Dropped transactions roll back through SQLx.
    workers.shutdown().await;
    if let Some(pool) = pool {
        // Closing the pool rejects new acquisitions from any remaining HTTP tasks.
        if tokio::time::timeout(std::time::Duration::from_secs(5), pool.close())
            .await
            .is_err()
        {
            tracing::warn!("database connection close deadline exceeded");
        }
    }
    if let Some(provider) = telemetry {
        let _ = provider.shutdown();
    }
    result
}

async fn shutdown_signal() -> std::io::Result<()> {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
        tokio::select! {
            result = tokio::signal::ctrl_c() => result,
            _ = terminate.recv() => Ok(()),
        }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c().await
}
