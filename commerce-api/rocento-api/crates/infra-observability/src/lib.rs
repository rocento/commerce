use axum::{
    extract::{MatchedPath, Request},
    middleware::Next,
    response::Response,
};
use opentelemetry::{
    global,
    propagation::Extractor,
    trace::{TraceContextExt, TracerProvider},
};
use opentelemetry_otlp::WithExportConfig;
use std::{
    collections::BTreeMap,
    sync::{Mutex, OnceLock},
    time::Instant,
};
use tracing::Instrument;
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

mod timing;
pub use timing::{
    inventory_expiry_batch_size, record_db_pool_snapshot, DbPoolSnapshot, Operation,
    OperationResult, OperationTimer,
};

pub fn init() -> Option<opentelemetry_sdk::trace::SdkTracerProvider> {
    init_service("commerce-gateway")
}

pub fn init_service(service: &'static str) -> Option<opentelemetry_sdk::trace::SdkTracerProvider> {
    global::set_text_map_propagator(opentelemetry_sdk::propagation::TraceContextPropagator::new());
    let provider = otlp_endpoint().map(|endpoint| {
        let exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_endpoint(format!("{}/v1/traces", endpoint.trim_end_matches('/')))
            .build()
            .expect("OTLP exporter configuration");
        opentelemetry_sdk::trace::SdkTracerProvider::builder()
            .with_resource(
                opentelemetry_sdk::Resource::builder()
                    .with_service_name(service)
                    .build(),
            )
            .with_batch_exporter(exporter)
            .build()
    });
    let otel = provider
        .as_ref()
        .map(|p| tracing_opentelemetry::layer().with_tracer(p.tracer("commerce")));
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .with(tracing_subscriber::fmt::layer().json())
        .with(otel)
        .init();
    provider
}
pub fn otlp_endpoint() -> Option<String> {
    std::env::var("OTEL_EXPORTER_OTLP_ENDPOINT").ok()
}
struct Headers<'a>(&'a axum::http::HeaderMap);
impl Extractor for Headers<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key)?.to_str().ok()
    }
    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(|k| k.as_str()).collect()
    }
}
#[derive(Default)]
struct Metric {
    count: u64,
    errors: u64,
    seconds: f64,
    buckets: [u64; 7],
}
static METRICS: OnceLock<Mutex<BTreeMap<(String, String), Metric>>> = OnceLock::new();
const BOUNDS: [f64; 7] = [0.01, 0.05, 0.1, 0.25, 0.5, 1.0, 5.0];
pub async fn request_trace(request: Request, next: Next) -> Response {
    let start = Instant::now();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map(|r| r.as_str())
        .unwrap_or("unmatched")
        .to_owned();
    let method = match request.method().as_str() {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "HEAD" => "HEAD",
        _ => "OTHER",
    }
    .to_owned();
    let parent = global::get_text_map_propagator(|p| p.extract(&Headers(request.headers())));
    let span = tracing::info_span!("http.request",otel.kind="server",http.route=%route,http.request.method=%method,http.response.status_code=tracing::field::Empty,otel.status_code=tracing::field::Empty);
    let _ = span.set_parent(parent);
    let trace_id = span.context().span().span_context().trace_id().to_string();
    let mut response = next.run(request).instrument(span.clone()).await;
    span.record("http.response.status_code", response.status().as_u16());
    if response.status().is_server_error() {
        span.record("otel.status_code", "ERROR");
    }
    let seconds = start.elapsed().as_secs_f64();
    if route != "/metrics" {
        let mut metrics = METRICS
            .get_or_init(Default::default)
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let m = metrics.entry((route.clone(), method)).or_default();
        m.count += 1;
        m.errors += u64::from(response.status().is_server_error());
        m.seconds += seconds;
        for (i, bound) in BOUNDS.iter().enumerate() {
            if seconds <= *bound {
                m.buckets[i] += 1;
            }
        }
    }
    if let Ok(header) = trace_id.parse() {
        response.headers_mut().insert("x-trace-id", header);
    }
    // Operational records contain route templates, never URLs, queries, bodies or credentials.
    tracing::info!(parent:&span,%trace_id,route=%route,status=response.status().as_u16(),duration_seconds=seconds,"request completed");
    if let Some(sender) = LOGS.get() {
        let _=sender.try_send(serde_json::json!({"trace_id":trace_id,"route":route,"status":response.status().as_u16(),"duration_seconds":seconds}).to_string());
    }
    response
}
pub async fn metrics() -> ([(&'static str, &'static str); 1], String) {
    use std::fmt::Write;
    let metrics = METRICS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let mut out=String::from("# TYPE commerce_http_requests_total counter\n# TYPE commerce_http_errors_total counter\n# TYPE commerce_http_duration_seconds histogram\n");
    for ((route, method), m) in metrics.iter() {
        let labels = format!("route={route:?},method={method:?}");
        let _=writeln!(out,"commerce_http_requests_total{{{labels}}} {}\ncommerce_http_errors_total{{{labels}}} {}\ncommerce_http_duration_seconds_sum{{{labels}}} {}\ncommerce_http_duration_seconds_count{{{labels}}} {}",m.count,m.errors,m.seconds,m.count);
        for (i, bound) in BOUNDS.iter().enumerate() {
            let _ = writeln!(
                out,
                "commerce_http_duration_seconds_bucket{{{labels},le=\"{bound}\"}} {}",
                m.buckets[i]
            );
        }
        let _ = writeln!(
            out,
            "commerce_http_duration_seconds_bucket{{{labels},le=\"+Inf\"}} {}",
            m.count
        );
    }
    let _ = writeln!(out,"# TYPE commerce_reporting_last_success_seconds gauge\ncommerce_reporting_last_success_seconds {}\n# TYPE commerce_reporting_visitors gauge\ncommerce_reporting_visitors {}\n# TYPE commerce_reporting_purchases gauge\ncommerce_reporting_purchases {}",REPORT_SUCCESS.load(std::sync::atomic::Ordering::Relaxed),REPORT_VISITORS.load(std::sync::atomic::Ordering::Relaxed),REPORT_PURCHASES.load(std::sync::atomic::Ordering::Relaxed));
    for (name, count) in FULFILLMENT_METRICS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
    {
        let _ = writeln!(out, "# TYPE {name} counter\n{name} {count}");
    }
    timing::append_metrics(&mut out);
    ([("content-type", "text/plain; version=0.0.4")], out)
}
static LOGS: OnceLock<tokio::sync::mpsc::Sender<String>> = OnceLock::new();
/// Bounded, best-effort sanitized request log shipping; Loki failure never blocks commerce.
pub fn start_log_shipping() {
    let Ok(url) = std::env::var("LOKI_URL") else {
        return;
    };
    let (sender, mut receiver) = tokio::sync::mpsc::channel::<String>(1024);
    if LOGS.set(sender).is_err() {
        return;
    }
    tokio::spawn(async move {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(3))
            .build()
            .expect("log client");
        while let Some(line) = receiver.recv().await {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
                .to_string();
            let payload = serde_json::json!({"streams":[{"stream":{"service":"commerce-gateway"},"values":[[now,line]]}]});
            let _ = client
                .post(format!("{}/loki/api/v1/push", url.trim_end_matches('/')))
                .json(&payload)
                .send()
                .await;
        }
    });
}

static REPORT_SUCCESS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static REPORT_VISITORS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static REPORT_PURCHASES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub fn reporting_metrics(timestamp: u64, visitors: u64, purchases: u64) {
    REPORT_SUCCESS.store(timestamp, std::sync::atomic::Ordering::Relaxed);
    REPORT_VISITORS.store(visitors, std::sync::atomic::Ordering::Relaxed);
    REPORT_PURCHASES.store(purchases, std::sync::atomic::Ordering::Relaxed);
}

static FULFILLMENT_METRICS: OnceLock<Mutex<BTreeMap<&'static str, u64>>> = OnceLock::new();
/// Bounded names and no customer/slot labels: installation identity is supplied by deployment.
pub fn fulfillment_metric(name: &'static str, count: u64) {
    if ![
        "fulfillment_capacity_reserved_total",
        "fulfillment_capacity_rejected_total",
        "fulfillment_capacity_released_total",
        "fulfillment_reservation_expired_total",
        "fulfillment_reservation_confirmation_failure_total",
    ]
    .contains(&name)
    {
        return;
    }
    let mut values = FULFILLMENT_METRICS
        .get_or_init(Default::default)
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    *values.entry(name).or_default() += count;
}
