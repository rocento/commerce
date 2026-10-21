# Tracing evidence contract

This reference defines the implemented v1/v2 report semantics, derived journey facts and private service-boundary protocol. Reviewed against source on 2026-10-14. Reader compatibility is recorded as deployed; the capture-v2 producer remains blocked after its live latency gate failed. Capability here does not mean a current production report contains v2 evidence. See [rollout status](tracing-rollout.md).

Current sources: [journey projection](../../commerce-web/apps/rengine/journey.mjs), [diagnostic derivation](../../commerce-web/apps/rengine/public/trace-diagnostics.js), [navigation model](../../commerce-web/apps/rengine/public/trace-navigation.js) and [journey renderer](../../commerce-web/apps/rengine/public/journey.js). The [dated implementation record](history/tracing-evidence-contract-2026-10-14.md) preserves the original M0–M4 inventory, local results and superseded UI design.

## Evidence ownership

Python diagnostics owns captured events, selected function/source snapshots and the Python clock. Language responses own interpretation, rule candidates and release provenance. The existing shopping workflow owns catalog calls and local filters; provider adapters own actual dispatch/validated usage. Application completion policy owns completion evidence. rengine derives views from the already authorized, redacted report; it does not create missing execution facts.

Tracking-list latency/call defaults are not evidence for missing values in a report. Guest-test browser observations remain distinct from arbitrary production captures and server emission timing. Missing fields are unknown, never zero or proof that a stage did not run.

## Journey projection and legacy report semantics

`customerJourney(report)` adds `capture`, `eventIndex`, `callId`, and `diagnostics` without changing the upstream report or export payload.

- `capture`: `{version: number|null, redacted: boolean|null}`.
- `eventIndex`: original zero-based position in the immutable report, retained when sorting by start time.
- `id` for legacy events: `step-${eventIndex}`. Unique within one report and stable across reads of the same immutable report. It is not a global trace/span ID and is not promised stable across changing live event arrays.
- `callId`: existing captured function-call identity, or null. Scoped to the request; separate from event identity.
- `diagnostics.version`: `2` in the current reader, independent of report capture version. The fields below apply to both supported report versions; richer v2 facts are described below.
- `diagnostics.goal`: `{value: string|null, evidence: string[], note: string}`. Prefer final intent, then the last initial interpretation, then the last rule result in original capture order.
- `diagnostics.execution`: `{value, evidence}`. Values: completed, failed, unavailable, denied, disconnected, completion_not_captured. A function return is never a terminal event.
- `diagnostics.businessOutcome`: `{value, note, evidence}`. Legacy reports without authoritative completion evidence remain unknown, blocked, failed, or clarification_needed. Capture-v2 fulfillment requires the completion-policy evidence below; a handler marker alone is insufficient and partial fulfillment is not inferred.
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

Within a priority, preserve original capture order. Errors may have been recovered; each finding directs the operator to inspect the terminal result. A longest-span finding does not establish a bottleneck or a production latency violation. The fallback producer emits an object with an outcome, including unconfigured; its presence does not prove a model call.

### Timing, usage, and score semantics

- Never add function durations to produce request latency. Parent work and concurrent work overlap.
- Legacy reports without the required v2 measurements leave request duration, time to first text and complete model-call count unavailable. Cost remains unavailable in every report version.
- Token subtotals include only nonnegative safe-integer values in captured `language_model_response` events. Keep actual zero distinct from missing. Input and output can have different evidence coverage. Every subtotal is labeled as captured-response usage, not a request total, including in untruncated reports.
- Rule margin compares selected first-ranked candidate to the next candidate within the same captured ranking, only with valid ordered numeric scores. Do not compare different generations or interpret scores as confidence probabilities.
- Redaction and truncation always remain visible as limits on interpretation. No completeness percentage is calculated.

## Capture v2

The local v2 producer writes report version 2 with the same envelope and bounded event list. The gateway now accepts exactly versions 1 and 2, still checks request identity and the 96-event limit, and preserves JSON evidence for both reads and audited exports. Unknown versions remain rejected. No database migration is required.

### Identity and clocks

Every new event has `_journey.eventId`, `traceId`, `service`, `clockDomain`, `spanId`, and `parentSpanId`, alongside existing timing and source fields. IDs are scoped to one request: event IDs are `event-N`; operation spans are `span-N`. The service is `assistant-python`; event offsets use `python-perf-counter`. Trace UUID and clock domain are separate fields so redaction does not mistake a composite identifier for contact information.

Function start and completion have different event IDs and the same span ID, parent, and existing call ID. Start events remain live-only; their gaps in a saved event-ID sequence do not mean durable events were dropped. Parent state is task-local, bound to the capture instance, and reset after return, exception, and cancellation. A closed capture cannot be mutated by a late-finishing child task.

rengine uses `span:<spanId>` for function/attempt identity and `event:<eventId>` for other v2 steps. It coalesces a live function start with its completion, retains completed evidence if a late start arrives, and preserves original event index separately from display order. Legacy steps retain their existing index identity. Chronological sorting requires a shared clock domain; this does not claim clock alignment across services. The inspector follows explicit parent links; the current cards UI is documented in [usage](usage.md).

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

## Connected service boundaries

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

Remote records retain their own clock and can navigate to explicit Python parents in the inspector. Current presentation uses cards and section navigation; no shared-clock waterfall, cross-service overlap or critical-path claim is implied. Older reports retain their available evidence.

## Fixtures and verification

`commerce-web/apps/rengine/tests/fixtures/trace-diagnostics.json` contains hand-authored synthetic captures with no real customer data: completed without proof, clarification, denial, model recovery/partial usage, legacy evidence, failure, and concurrent catalog calls.

`trace-diagnostics.test.mjs` covers outcome separation, missingness, numeric validation, zero usage, precedence, evidence links, immutable projection, ranking facts, and concurrent identity. Existing journey/presentation tests retain generation/source and catalog coverage. Browser additions verify clickable findings, focus transfer, disclosure contents, capture warnings, legacy reports, and widths 390/768/1024/1512, alongside existing history, export, permissions, source/rule and keyboard checks.

## Deployment and verification boundary

Deploy compatible gateway and rengine readers before a v2 Python/language producer. Unknown report versions remain rejected. No historical report is backfilled. The [rollout runbook](tracing-rollout.md) owns new canary acceptance; [history](history/README.md) owns dated tests and failed/successful deployment results. Current navigation is documented in [usage](usage.md), not in the historical Waterfall milestone.
