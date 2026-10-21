# Observability

## Base Gateway Observability

The analytics worker has a separate private `/metrics` endpoint on port 8082 and service/job name `commerce-analytics`. Reporting freshness and analytics readiness alerts use this job. Worker readiness does not imply zero event backlog; inspect report generation age as well.

The gateway initializes observability through `infra-observability`, serves `/metrics`, and wraps requests with tracing middleware.

The [commerce reliability baseline](commerce-reliability.md) adds a focused dashboard, bounded queue diagnostics, a dependency map, and an isolated correctness/load runner.

## Optional Local Stack

Use:

```sh
docker compose -f commerce-ops/compose/compose.yaml -f commerce-ops/compose/compose.observability.yaml up -d
```

The overlay adds:

- OpenTelemetry Collector
- Tempo
- Loki
- Prometheus
- Alertmanager
- local alert receiver
- Grafana

Local ports:

- OTLP HTTP: `localhost:4318`
- Tempo: `localhost:3200`
- Loki: `localhost:3100`
- Prometheus: `localhost:9090`
- Alertmanager: `localhost:9093`
- Grafana: `localhost:3000`

The external Alertmanager template in `commerce-ops/deploy/observability/alertmanager-external.example.yaml` contains placeholders and should only be completed after authorizing real notifications.


## Assistant outcome report

Admin `/reports/ai-models` is protected by `reports.read`. Its model-usage and shopper-activity sections read `/v1/admin/assistant/usage`, while merchant activity reads `/v1/admin/assistant/metrics`. All sections cover the rolling last 24 hours. Model usage includes a provider/model table, input/output token totals, estimated USD cost and pricing coverage. Internal result labels (`commerce-language-engine`, `approved-knowledge`, `deterministic`, `unconfigured`) are excluded from model rows and model usage/cost aggregates; they remain included in conversation, turn, feedback and operational activity counts. This changes reporting only and preserves the engines and their stored telemetry.

The separate request-outcomes section reads `/v1/admin/reports/assistant`. It reports the current installation’s deduplicated assistant outcomes and average recorded turn latency. The telemetry table is written asynchronously, so an empty outcome feed does not mean there were no conversations. Each section has its own loading/error state, and refreshing waits for all three sources.

The outcome feed scopes by the configured assistant installation UUID and uses millisecond precision at the current-time boundary. This feed does not collect model identity, token counts, costs or answer-quality scores. A completed outcome measures request completion only. Usage and cost estimates come from the separate usage source; absent pricing must not be displayed as zero cost. Model rows show up to ten reported models, so the summary totals remain authoritative and must not be reconstructed from visible rows.
