# rengine tracing improvement plan

This plan owns remaining capture-v2 producer qualification. Current UI behavior belongs in [usage](usage.md), the wire/evidence rules in [the contract](tracing-evidence-contract.md), and production commands in [the rollout guide](tracing-rollout.md).

| Field | Value |
| --- | --- |
| Owner | rengine and AI service maintainers |
| Status | Producer rollout blocked by measured latency; compatible readers retained |
| Reviewed | 2026-10-14 against source and recorded evidence; no production inspection |
| Last production evidence | [2026-10-11 canaries and rollback](history/tracing-rollout-2026-10-14.md) |
| Next review | After profiling or a new frozen canary result |
| Earlier design and tasks | [Full plan retained on 2026-10-14](history/tracing-improvement-plan-2026-10-14.md) |

## Lifecycle and known boundary

| Layer | Implementation | Local verification | Deployment | Production acceptance |
| --- | --- | --- | --- | --- |
| Gateway/rengine v1/v2 readers | Implemented | Recorded reader, authorization and UI checks pass | Recorded as deployed on 2026-10-11 | Legacy/canary reads, isolation, unauthorized export denial and readiness passed for that build |
| Current card/section UI | Present in current source | Historical UI checks do not establish this checkout's current test result | Not rechecked during this documentation refactor | Requires verification of the installed build |
| Capture-v2 Python/language producer | Implemented locally, including connected boundaries | Functional, wire and disposable-database checks recorded | Live canaries rolled back | Failed unchanged capture overhead gate, including the revision-12 retry |
| Lighter health probes | Implemented | 16 behavior tests recorded | Recorded as deployed to all demos | Healthy after final rollback; this does not close the capture latency failure |

The original M3 Waterfall/side-inspector design is historical. Current source uses the Execution timeline cards and details beneath them. Preserve evidence semantics and access boundaries when changing presentation; no new renderer is required merely to match an old milestone description.

## Next work

1. Profile full-turn capture CPU under the actual container CPU limit. Separate time before `done`, after `done`, report persistence, health-probe CPU and throttling. The last slow captured request spent only 14.8 ms after `done`; local report-save p95 was approximately 10 ms. Asynchronous persistence alone is not an established fix.
2. Freeze a bounded producer change and exact source, runtime, release/artifact identities. Reinspect the active knowledge release and coordinate a matching producer baseline before another canary.
3. Preserve behavior under capture off, nested/concurrent spans, cancellation, failed calls, truncation, tenant checks, redaction and audited export. Parent identity and clock domains must remain explicit; missing timing or usage stays unknown.
4. Run affected suites and the [rollout checker](../../commerce-ops/scripts/checks/check-trace-rollout.mjs) against a redacted complete v2 report. Functional pass and performance pass are separate gates.
5. Run an authorized one-demo canary with quota headroom and the unchanged numeric gate. Keep retained readers and restore producer images/settings if it fails; do not retry an unchanged candidate repeatedly.
6. Expand to the remaining demos only after the first candidate meets every gate and has a reviewed recovery path. Record each lifecycle result separately in [history](history/README.md).

## Acceptance

Use the [rollout guide](tracing-rollout.md) for the precise procedure. Capture-on full-stream p95 must be at most `max(capture-off p95 × 1.25, capture-off p95 + 100 ms)` for the agreed representative workload. Retain `done` and post-`done` measurements for diagnosis without replacing the EOF gate after seeing a failing result.

Also require complete terminal evidence within 96 events/1 MB, valid gateway/Python/language/catalog links, independent remote clocks, capture-off equivalence, normal assistant behavior, legacy report access, tenant/read/export boundaries and matching knowledge runtime. Do not fabricate gateway/browser end-to-end spans, provider internals, self time or a critical path.

AI-generated diagnoses, a new analytics database, organization-wide alerting, cost estimates without versioned pricing, and new large evaluation datasets remain outside this increment. Existing [operations verification](operations.md#verification) provides the reader check entry points; producer changes additionally require their affected AI and gateway suites.
