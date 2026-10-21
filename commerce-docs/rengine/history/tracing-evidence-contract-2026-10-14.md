# Tracing evidence contract — M0 through M4

> Historical snapshot retained on 2026-10-14. UI descriptions, deployment identities and validation results apply to their recorded milestones; later source changes supersede the Waterfall/side-inspector layout. Use the [current rengine guides](../README.md), [usage](../usage.md), [operations](../operations.md) and [rollout gates](../tracing-rollout.md) for new work.

Date: 2026-10-10  
Implementation: `rengine/public/trace-diagnostics.js`, `rengine/public/trace-navigation.js`, `rengine/public/journey.js`, `rengine/journey.mjs`  
Scope: the first sections record the M0/M1 baseline. The implemented M2 extension below supersedes the listed capture gaps for v2 reports. Existing permission and storage boundaries remain unchanged.

## Evidence inventory

Paths below are relative to the repository root. Producers are the source of truth; absent values remain unknown.

| Existing evidence | Producer / location | Current use | Limitation / later work |
| --- | --- | --- | --- |
| Message, event offsets, function call ID, inclusive duration | `ai-service/app/commerce_resolution_engine/diagnostics.py` | Original message, source-linked function details, longest recorded span | Python capture clock only; no explicit parent relationship. |
| Interpretation status, intent, requested actions, release | `application/interpretation_diagnostics.py` under `commerce_action_engine` | Initial interpretation facts and final goal when present | Not verified customer intent; initial and final interpretation can differ. |
| Rule candidates and diagnostic text/entities | `language_rule_evidence` envelope | Selected candidate, next ranked candidate, score margin, normalization and entity details | Definitions require matching generation. Missing conditions stay missing. Scores are not probabilities. |
| Operation, criteria, result count | `ShoppingCatalog.call` function details | Per-call catalog summaries | A zero count does not explain why nothing matched. |
| Aggregate local-filter counts and checks | `application/shopping_flow/retrieval.py` under `commerce_action_engine` | Before/after facts and empty-result finding | Per-filter counts require M2 instrumentation. |
| Prepared messages/schema/output limit | `commerce_resolution_engine/language.py` | Model input facts | No provider-attempt identity or prompt version. |
| Model response, model name, input/output usage, finish reason | `commerce_resolution_engine/language.py` | Per-response facts and captured response token subtotals | Does not cover every model/provider path or retries; validation follows this event. |
| Provider payload and validation failure | `commerce_resolution_engine/providers/openai.py` | Requested model and validation failure facts | Payload preparation is not execution; unverified invalid-response usage is not included in token subtotals. |
| Terminal outcome, gate, route, handler completion marker, fallback outcome | `application/handle_turn.py` under `commerce_action_engine` | Execution status, conservative business state, final interpreted goal | Full persisted completion metadata and disposition are not in this diagnostic event. |
| Capture version, truncation, redaction | Diagnostic report and tracking store | Completeness disclosure | No truncation flag is not proof that every boundary was instrumented. |
| Latency/model call totals in trace history | Tracking-list SQL over message metadata | Existing history view only | Do not join list defaults into evidence: coalesced zero can mean absent metadata. |
| First-text arrival timing | rengine guest request runner | Guest-test view only | Not available for arbitrary production reports and not equivalent to server emission time. |

## Presentation contract v1 (implemented)

`customerJourney(report)` adds `capture`, `eventIndex`, `callId`, and `diagnostics` without changing the upstream report or export payload.

- `capture`: `{version: number|null, redacted: boolean|null}`.
- `eventIndex`: original zero-based position in the immutable report, retained when sorting by start time.
- `id`: existing `step-${eventIndex}`. Unique within one report and stable across reads of the same immutable report. It is not a global trace/span ID and is not promised stable across changing live event arrays.
- `callId`: existing captured function-call identity, or null. Scoped to the request; separate from event identity.
- `diagnostics.version`: `1`, the deterministic derivation version, independent of capture version.
- `diagnostics.goal`: `{value: string|null, evidence: string[], note: string}`. Prefer final intent, then the last initial interpretation, then the last rule result in original capture order.
- `diagnostics.execution`: `{value, evidence}`. Values: completed, failed, unavailable, denied, disconnected, completion_not_captured. A function return is never a terminal event.
- `diagnostics.businessOutcome`: `{value, note, evidence}`. M1 emits unknown, blocked, failed, or clarification_needed only. Fulfilled and partially_fulfilled are reserved for future complete goal/result evidence, not inferred from a handler marker.
- `diagnostics.findings`: ordered `{id, priority, title, description, evidence: string[]}` objects.
- `diagnostics.metrics`: requestDuration, firstText, modelCalls, inputTokens, outputTokens, estimatedCost. Each contains `{value: number|null, state: derived|not_recorded, evidence: string[], note: string}`.
- `diagnostics.capture`: capture version, tri-state redaction, truncation boolean, timing (recorded/partial/not_recorded), modelInput and terminal (recorded/not_recorded).
- `stepFacts(step)`: selected facts `{key, label, value, state: recorded|not_recorded, note, evidence}`. It validates numeric counts and scalar fields before deriving values. Structured captured evidence is rendered as text, never HTML.

All evidence references resolve to an existing step in the same authorized journey. References with missing values identify where the expected fact was absent; they do not imply it was observed. Facts are generated from the already-redacted report, and nothing is persisted by the projection.

### Outcome mapping

1. Explicit denial or a terminal access/login restriction means blocked.
2. Terminal error, failure, or unavailability means failed.
3. Completed execution with terminal AMBIGUOUS/NEEDS_CONTEXT or one of the existing clarification routes means clarification_needed.
4. Everything else remains unknown, including completed execution with only response text or a handler completion marker.

Only a terminal event can establish request-level execution status. Disconnection does not establish whether a prior action committed. Pending live functions do not establish whether the whole request is still running. The UI exposes completion_not_captured until terminal evidence exists.

The clarification route allowlist follows the existing application completion policy: language_engine_clarify, language_engine_context, product_action_choice, delivery_location_required, reorder_review. It intentionally does not reconstruct the application's full completion policy from an incomplete report.

### Finding precedence

1. Recorded step errors / provider validation failure / terminal failure.
2. Blocked outcome or clarification.
3. Zero results from a completed catalog search or aggregate local filtering.
4. Empty/unavailable/unconfigured example lookup and explicit fallback outcome.
5. Longest measured span, labeled inclusive and never called a proven bottleneck.

Within a priority, preserve original capture order. Errors may have been recovered; each finding directs the operator to inspect the terminal result. There is no configured slow threshold, so M1 does not claim slowness. The fallback producer emits an object with an outcome, including unconfigured; its presence does not prove a model call.

### Timing, usage, and score semantics

- Never add function durations to produce request latency. Parent work and concurrent work overlap.
- M1 leaves request duration, time to first text, complete model-call count, and cost unavailable.
- Token subtotals include only nonnegative safe-integer values in captured `language_model_response` events. Keep actual zero distinct from missing. Input and output can have different evidence coverage. Every subtotal is labeled as captured-response usage, not a request total, including in untruncated reports.
- Rule margin compares selected first-ranked candidate to the next candidate within the same captured ranking, only with valid ordered numeric scores. Do not compare different generations or interpret scores as confidence probabilities.
- Redaction and truncation always remain visible as limits on interpretation. No completeness percentage is calculated.

## Capture v2 and presentation v2 — M2 implemented

M2 writes report version 2 with the same envelope and bounded event list. The gateway now accepts exactly versions 1 and 2, still checks request identity and the 96-event limit, and preserves JSON evidence for both reads and audited exports. Unknown versions remain rejected. No database migration is required.

### Identity and clocks

Every new event has `_journey.eventId`, `traceId`, `service`, `clockDomain`, `spanId`, and `parentSpanId`, alongside existing timing and source fields. IDs are scoped to one request: event IDs are `event-N`; operation spans are `span-N`. The service is `assistant-python`; event offsets use `python-perf-counter`. Trace UUID and clock domain are separate fields so redaction does not mistake a composite identifier for contact information.

Function start and completion have different event IDs and the same span ID, parent, and existing call ID. Start events remain live-only; their gaps in a saved event-ID sequence do not mean durable events were dropped. Parent state is task-local, bound to the capture instance, and reset after return, exception, and cancellation. A closed capture cannot be mutated by a late-finishing child task.

rengine uses `span:<spanId>` for function/attempt identity and `event:<eventId>` for other v2 steps. It coalesces a live function start with its completion, retains completed evidence if a late start arrives, and preserves original event index separately from display order. Legacy steps retain their existing index identity. Chronological sorting requires a shared clock domain; this does not claim clock alignment across services. Parent relations are captured now; rendering hierarchy is M3.

### Provider evidence

`provider_attempt` is written once for each actual OpenAI Responses transport dispatch. A request rejected during payload validation, admission, or budget checks is not a dispatch. Prepared payloads and provider validation events share the operation's span ID, allowing correlation without counting them as extra calls.

The event records attempt ID, generate/stream mode, requested/returned model, outcome, allowlisted error code, prompt/schema fingerprint, adapter-validation result, validated input/output tokens when available, and dispatch timing. It never records credentials or arbitrary exception text. The span starts before payload preparation; `dispatch_start_ms` and `dispatch_duration_ms` separately measure transport dispatch through adapter result/validation. Caller-requested streaming close and cancellation preserve their behavior and leave usage unknown unless a validated completed response was obtained.

The prompt fingerprint hashes the actual prepared instructions, tool definitions, and output schema. It excludes conversation input and tool outputs. It is a content identity, not a deployed prompt version. A provider response accepted by the adapter is not proof of downstream interpretation or shopping success.

The final event contains `provider_totals` version 1 with scope `openai_responses_dispatch`, attempts, completed responses, validated token totals, and `usage_complete`. Counters continue even when individual events are omitted by report limits. Usage is partial if any dispatched attempt lacks a validated response; zero is shown only when actually established. No language-response subtotal is added again. Embeddings and non-Responses transports are outside this scope. Cost remains unavailable: existing cost metadata does not supply the required versioned price/currency contract.

### Lifecycle and completion

`final_result.measurements` version 1 contains the trace UUID, `python-turn-monotonic` clock domain, milliseconds, request duration from Python turn start to lease closure, and first text-event creation time. First-text timing is marked after event validation. The measurement excludes gateway admission, tracking persistence, and browser delivery; it is not client end-to-end latency. Missing or incompatible timing stays unknown.

`final_result.completion` contains an allowlisted copy of the application's existing completion-policy result: version, status, request/task completion flags, evidence, intent, mode, and clarification/recovery flags. It does not copy actor identity or prior-request recovery IDs. The UI can show fulfilled only for a completed terminal lifecycle and a coherent completed/task-completed policy result with known authoritative evidence. Clarification, denial, unsupported work, and unavailability remain separate from lifecycle success. Partial fulfillment is still not inferred because the application has no authoritative partial-completion status.

### Product filtering and example inclusion

`catalog_filter.check_steps` contains ordered check labels, before/after counts, and bounded reason codes. Ordinary local filters record their actual sequential counts. Requirement verification reuses each actual verifier result exactly once; its ordered cumulative elimination counts carry `effect: ordered_verification_results`. This is an explanation of recorded verification results, not a new sequence of product decisions or independent causal test. Eligibility and catalog request count are unchanged when capture is on.

Up to 20 individual hard requirements are shown; any remaining requirements are grouped into one final counted check. Conflicts have their own bounded check. The existing finite set of local filters keeps the combined list below 32 rows. A later required-product-ID filter receives its own small event because it runs after intermediate clarification/return boundaries. No full product result, product identity, or per-product rejection payload is added.

Example retrieval records explicit source/revision/chunk/example references. Language-model input preparation records references for the examples actually inserted. rengine links only matching complete identities in later prepared inputs. This proves prepared-input inclusion, not successful dispatch or model use. Missing links remain unknown, particularly in truncated reports.

### Bounds, privacy, and capture off

The report still allows at most 96 events and a one-million-byte capture budget. Reserve one event and 32 KB for the terminal record, plus envelope headroom. Under byte pressure, terminal answer/blocks/source and nonessential details are omitted with `terminal_details_truncated: true`; completion and measurements are prioritized. Whole-report truncation remains explicit. Live delivery retains its existing bounded ring and gap signaling.

All fields flow through existing store/live redaction, tenant checks, read audits, and export audits. Turning capture off prevents new span/source inspection, prompt hashing, detailed filter accounting, and diagnostic lifecycle projection. Ordinary operational telemetry continues. Active requests retain the capture decision selected at their start.

### Deployment order

1. Deploy gateway compatibility (report v1/v2 acceptance), then rengine's v2 reader.
2. Deploy Python capture changes to one demo and verify newly generated v2 reports, capture-off behavior, live delivery, and export.
3. Roll out to remaining demos only after that verification.

Do not deploy a v2 producer behind the old v1-only gateway. An older rengine can display the generic events, but the older gateway must not be used to read v2 reports. No production deployment was performed during implementation. M3 supplies the waterfall; M4 supplies cross-service propagation. No old evidence is backfilled.

## Fixtures and verification

`rengine/tests/fixtures/trace-diagnostics.json` contains hand-authored synthetic captures with no real customer data: completed without proof, clarification, denial, model recovery/partial usage, legacy evidence, failure, and concurrent catalog calls.

`trace-diagnostics.test.mjs` covers outcome separation, missingness, numeric validation, zero usage, precedence, evidence links, immutable projection, ranking facts, and concurrent identity. Existing journey/presentation tests retain generation/source and catalog coverage. Browser additions verify clickable findings, focus transfer, disclosure contents, capture warnings, legacy reports, and widths 390/768/1024/1512, alongside existing history, export, permissions, source/rule and keyboard checks.

### M0/M1 local verification result — 2026-10-10

- `node --test rengine/tests/*.test.mjs`: 45 passed, 0 failed.
- Syntax checks passed for app, journey renderer, journey presentation, and trace diagnostics.
- `node rengine/tests/browser.mjs`: passed, including the new diagnostic-summary scenarios.
- Desktop and mobile screenshots inspected: `/tmp/rengine-m01-summary-desktop.png`, `/tmp/rengine-m01-summary-mobile.png`.
- Server/browser tests used synthetic upstream fixtures and temporary localhost listeners. No production requests or deployments were performed.
- Python tests were not run because M0/M1 made no Python or capture-producer changes. M2 requires producer and persistence validation.

### M2 local verification result — 2026-10-10

- Affected Python suites: 327 passed, 7 deselected. The seven existing dictionary-dependent cases cannot load the packaged recognition rules (`A complete versioned recognition rule set is required; upgrade the dictionary before publishing`): six typo-checkout cases and one packaged-corpus publishing case. These remain unverified; the dictionary was not changed for M2.
- PostgreSQL tracking/completion/readiness checks: 15 passed against a disposable local pgvector database with the actual migrations, including v1/v2 persistence. The temporary container was removed; no production database was touched.
- Gateway tracking tests: 2 passed, including v1/v2 acceptance, unknown-version rejection, request identity, evidence round-trip, and event bounds.
- rengine unit/server tests: 51 passed. The browser suite verifies the v2 summary, provider/filter facts, example inclusion links, JSON export, legacy captures, and responsive layouts.
- Scoped Ruff and mypy checks passed; mypy covered all nine changed Python implementation files.
- New capture tests cover concurrent/nested spans and provider attempts, cancellation, completed-stream close, closed captures, capture-off hashing, actual transport counts, filter equivalence, redaction, and terminal retention under event/byte pressure.

Local logs and the benchmark script are in `output/rengine-m2-20261010/` at the repository root. The same warmed-cache microbenchmark ran 12 traced calls per trace, nine batches of 300 traces, discarding warm-up. Median capture-enabled time rose from 0.08604 to 0.12138 ms per trace (+0.03533 ms); disabled time rose from 0.00253 to 0.00304 ms (+0.00051 ms). Serialized report size rose from 6,047 to 8,444 bytes (+2,397 bytes). These are local instrumentation measurements, not production end-to-end latency or a claim of zero overhead.

A representative production workload and an agreed numeric overhead budget remain release gates before shipping M2. No deployment was performed. Deploy the compatible gateway and rengine readers before the Python producer, then verify one demo before wider rollout.


## M3 investigation interface — 2026-10-10

Overview is the default: expandable Input, Interpretation, Decision, Retrieval/tools, Model, and Outcome navigation groups appear only when supported by recorded events. Repeated occurrences remain separate within each group. These groups do not assert new execution stages. Generic Python functions appear under Decision; an explicit catalog operation belongs to Retrieval/tools.

Waterfall aligns only finite, nonnegative offsets explicitly identified as service `assistant-python` and clock `python-perf-counter`. Bars show inclusive measured duration; instantaneous events and running starts use markers. Running markers do not grow with wall time. Unknown or incompatible timing stays navigable in the untimed section in original event order. Legacy timing without an explicit clock/service is not silently aligned. The axis does not claim gateway/browser end-to-end latency, self time, or a critical path.

Hierarchy uses explicit parent references to recorded function/provider spans in the same service. Repeated operations and provider attempts retain distinct span IDs. Parent labels and inspector links expose captured relationships, without inventing retry relationships. Missing parents, duplicate parent identities, and cycles do not acquire inferred hierarchy; missing/cyclic relationships are labeled. The existing projection coalesces live start/completion records into the same span; rerendering retains selection for the same request.

The shared inspector stays beside navigation on wide screens and stacks below on screens up to 1,100 px. Overview, waterfall, findings, previous/next, playback, and the optional Cards view share selection. Cards retains its original zoom controls; overview/waterfall text is never scaled to fit. Arrow Up/Down and Home/End navigate visible event lists. Native disclosure and button keys remain available, focus is visible, and motion respects reduced-motion settings.

Problem navigation reuses deterministic findings and adds missing timing/parent/terminal evidence, truncation, and durations exceeding an editable threshold (default 1,000 ms). A threshold observation is not a root-cause finding. View and event selection use `traceView` and `event` URL parameters, with stable IDs only. Refresh retains selection; changing request/tenant clears it, and existing history/Back behavior remains intact. No new upstream reads, model calls, Python capture work, or permissions are introduced.

### M3 local verification

- 58 unit/server tests cover existing rengine behavior plus explicit nesting, overlap, repeated operations, live completion identity, missing parents, cycles, incompatible clocks, invalid/overflow timing, instantaneous events, and legacy navigation.
- Browser coverage includes shared view selection, URL/refresh restoration, threshold navigation, keyboard controls, actual bar overlap, live selection retention, legacy untimed events, and layouts at 390/768/1024/1512 px. Existing permissions, history, export, rule/source inspection, and card zoom checks remain included.
- The v2 synthetic fixture now supplies the producer's `assistant-python` service field on every event; absent service fields deliberately remain incompatible in the reader.
- Python and gateway implementations are unchanged in M3. M2's documented dictionary-fixture and production overhead release gates remain applicable. Nothing was deployed.

M3 test logs are saved in `output/rengine-m3-20261010/`. Desktop waterfall and mobile screenshots were inspected; the UI changes require only the compatible rengine reader deployment.

## M4 connected boundaries — local implementation

The additive v2 metadata now includes `parentService` and `clockId`. Cross-service links are correlation evidence, not nesting on a shared clock. Python retains `python-perf-counter`; remote handlers use `remote-handler` with a unique UUID clock ID per invocation and a local elapsed duration. No epoch conversion, inferred offsets, self time, or critical path is calculated.

The private internal protocol uses identifiers only:

- Request header `x-commerce-trace-request`: `1/<request UUID>/<Python boundary span ID>`.
- Response header `x-commerce-trace-response`: the exact request context followed by `/<remote span UUID>/<local duration ms>`.
- Gateway-to-Python header `x-commerce-trace-gateway`: `1/<signed request UUID>/<new gateway dispatch UUID>`. Gateway generates this value and does not forward a browser-supplied trace header. Python accepts it only when its request UUID matches the admitted request.

This is a private versioned protocol, not W3C traceparent or an OpenTelemetry export. Request and response headers are bounded to 160 and 240 characters; span IDs are bounded ASCII identifiers. Invalid contexts, mismatched requests/parents, nonfinite/negative/excessive durations, and malformed UUIDs produce missing remote evidence without changing business behavior. No authorization, identity, tenant, prompt, message, query, or product data is propagated in trace headers. Existing authentication and tenant-scoped report access remain authoritative.

Supported boundaries:

- Gateway dispatch is an untimed marker. Root Python function spans link to it. Gateway admission duration, stream completion, and browser delivery remain unavailable.
- Language `/api/resolve` returns a locally timed handler response, including HTTP errors handled by the route. Python separately records the transport interval and validates the existing language envelope. A response does not establish interpretation acceptance.
- Catalog transport records actual network fetches inside the existing cache/coalescing path. The gateway ties a response header to the signed `shopper_read` request UUID. Successful handler responses, including cache responses, include local elapsed time; gateway errors returned through the error path have only client-side transport evidence. Cache/coalescing behavior is unchanged; a shared fetch is recorded only by its originating capture, not invented for waiters.
- Provider attempts keep their existing parent relationship and explicitly mark provider server evidence unavailable. Provider-server internals, other commerce tool routes, embeddings, and database spans are not propagated in this slice.

Capture-off mode emits no downstream language/catalog trace context, handler records, or report links from Python. Gateway creates a small dispatch identifier before it can know the Python capture setting; the disabled Python capture does not retain it. Late tasks cannot append records after capture closure. Events retain the 96-event/1 MB bounds and terminal reservation, store/live redaction, and audited export. Remote UUIDs remain separate fields so redaction preserves their identity.

The waterfall retains its shared Python axis and adds service lanes for connected evidence. Each remote handler duration has its own local clock; service lanes do not imply remote overlap or alignment. Selecting a remote record opens the same inspector and can navigate back to the explicit Python parent. Missing links remain visible. Older reports retain their existing navigation.

### M4 local validation — 2026-10-10

- Affected Python capture, boundary, language gate, catalog transport/import isolation, model, tracking, and live suites: **230 passed**. Tests run from `ai-service`; language-dependent cases use the repository's temporary recognition-test fixture. Capture-off equivalence, mismatched/oversized metadata, malformed durations, cancellation, concurrency, redaction, and bounded terminal retention are covered.
- Disposable PostgreSQL tracking/completion/readiness checks: **15 passed**, now including persisted remote clock/parent fields. The container was removed; no production database was touched.
- rengine unit/server/checker tests: **61 passed**. Browser checks include the two connected service lanes, explicit parent navigation, retained Python axis, old captures, four viewport widths, and existing history/export/permission behavior.
- Language tests: **3 passed**, including traced/untraced requests through the actual language HTTP server. Full language TypeScript typecheck passed.
- Gateway trace helper test: **1 passed** after compiling the modified gateway/catalog handlers. Scoped Python Ruff and mypy checks passed.

The broader language-wire attempt remains limited by existing packaged artifacts: without the temporary recognition fixture, 25 cases cannot construct envelopes; with the fixture, **8 wire cases fail release/semantic assertions** because its fingerprint differs from Python's packaged artifact. The temporary fixture is not a production fix and the release compatibility guard was not weakened. The fixture-enabled broader run had 250 passing cases and 8 failing cases; its log is retained separately as `python-wire-fixture-limitations.log`. Run the entire wire suite again after the packaged release is repaired.

Logs are in `output/rengine-m4-20261010/`. The synthetic export passes `scripts/check-trace-rollout.mjs`; this verifies the checker, not production readiness. Canary deployment, real exported-report evidence, capture-on/off workload comparison, and the agreed overhead budget remain outstanding M4 rollout work. See [the rollout guide](../tracing-rollout.md).
