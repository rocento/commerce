# rengine tracing improvement plan

> Historical snapshot retained on 2026-10-14. UI descriptions, deployment identities and validation results apply to their recorded milestones; later source changes supersede the Waterfall/side-inspector layout. Use the [current rengine guides](../README.md), [usage](../usage.md), [operations](../operations.md) and [rollout gates](../tracing-rollout.md) for new work.

Date: 2026-10-10  
Status: Implementation through M4 is local. On 2026-10-11, compatible gateway readers and the rengine UI were deployed successfully. The v2 Python/language producer was rolled back after live latency-gate failures, including the revision-12 retry after health-probe optimization; its production rollout remains blocked. See [rollout results](../tracing-rollout.md).

Implementation contract and evidence inventory: [Tracing evidence contract](../tracing-evidence-contract.md).

M0/M1 delivery includes synthetic fixtures, versioned evidence projections, a diagnostic summary, linked deterministic findings, capture/measurement disclosures, and richer facts for current language, rule, model, filter, and terminal events. M2 adds application completion evidence, scoped provider dispatch/usage totals, Python turn timing, parent/span identity, explicit example-input links, and bounded per-check counts. Older reports retain explicit unknown states. Gateway-wide latency, browser arrival timing, versioned cost estimates, and cross-service propagation remain unavailable; M3 adds the expandable overview, measured Python waterfall, problem navigation, and shared inspector.

## Objective and scope

Make each trace answer three questions quickly: what the customer wanted, what actually happened, and which recorded step explains the result.

This plan covers the first three recommendations:

1. A diagnostic summary above every trace.
2. Cards that explain changes, decisions, and results.
3. A compact overview and a timing-accurate waterfall with a persistent inspector.

The implementation will prepare structured evidence for a future AI investigator. AI-generated diagnoses, evaluation datasets, release comparisons, organization-wide alerting, and a new analytics database are outside this scope. No model calls are needed to generate these summaries.

## Current foundation

The repository already provides category colors, separate step statuses, recorded function durations, catalog criteria and aggregate filter counts, routing explanations, rule-generation matching, captured source, and redaction/truncation notices. These behaviors must remain available.

The current journey renders all recorded steps across up to three rows and scales them to fit. Its projection sorts by recorded start time when every step has one. Python instrumentation supplies per-capture call IDs and start/duration values; live function-start events are separate from durable completed-function records. Parent-child relationships and stable presentation identity need explicit treatment.

Existing reports have a documented 96-event and 1 MB budget. Detailed capture can be disabled. Older reports cannot acquire evidence that was never recorded.

### Primary implementation locations

| Area | Existing files |
| --- | --- |
| Report-to-journey projection | `rengine/journey.mjs` |
| Card descriptions and classifications | `rengine/public/journey-presentation.js` |
| Journey rendering and inspector | `rengine/public/journey.js` |
| Trace navigation and report loading | `rengine/public/app.js` |
| Page structure and styles | `rengine/public/index.html`, `rengine/public/style.css` |
| Report serving and authorization integration | `rengine/server.mjs` |
| Python diagnostic function capture | `ai-service/app/commerce_resolution_engine/diagnostics.py` |
| Existing operational timing | `ai-service/app/commerce_action_engine/platform/telemetry.py` |
| Catalog filtering evidence | `ai-service/app/commerce_action_engine/application/shopping_flow/retrieval.py` |
| Report storage and live delivery | `ai-service/app/commerce_action_engine/platform/tracking.py`, `live_tracking.py` |

Paths are relative to the repository root. Inspect event producers and contracts before selecting additional files; the table is a starting map, not a complete edit list.

## Design rules

- Keep execution status, business outcome, and evidence completeness independent.
- Every displayed conclusion must reference captured evidence or an explicit, versioned deterministic derivation.
- Show unknown, unavailable, redacted, and truncated states distinctly. Missing evidence never proves a step was skipped.
- A returned function does not prove a successful commerce action. An assistant's success sentence does not replace an action receipt.
- Preserve tenant authorization, read/export auditing, source restrictions, and redaction.
- Do not sum nested or overlapping durations to calculate request latency.
- Capture only selected diagnostic facts; do not automatically collect arguments, locals, complete product payloads, or customer identities.
- Unknown event types remain inspectable through raw evidence.

## 1. Diagnostic summary

### Proposed layout

Place the summary between the customer message and the journey views. Show the most useful fields first and disclose secondary measurements when available.

| Field | Meaning and evidence rule |
| --- | --- |
| Customer goal | Recorded intent, entities, and constraints in readable form; retain the original message. Label this as the interpreted goal, not verified intent. |
| Business outcome | Fulfilled, partially fulfilled, clarification needed, blocked, failed, or unknown. Use explicit goal/action/result evidence; default to unknown when fulfillment cannot be established. |
| Execution status | Running, completed, failed, or completion not captured, derived from recorded lifecycle events. |
| Performance | Request duration, time to first text, model calls, tokens, and estimated cost when the corresponding evidence is available. |
| Main finding | A deterministic observation linked to supporting steps, such as an explicit tool error or a recorded filter reducing results to zero. |
| Capture completeness | Capture version, truncation, redaction, and availability of timing, model input, and terminal evidence. No invented completeness percentage. |

### Implementation tasks

- [x] Inventory existing report fields and distinguish production-report measurements from guest-test browser measurements.
- [x] Define versioned summary and finding projections with evidence references and explicit missing-data states.
- [x] Define and test business-outcome mappings. Treat denial and clarification as valid business states even when execution completed normally.
- [x] Render the summary from the same authorized report used by the cards.
- [x] Add deterministic finding rules with documented precedence: explicit failure, blocked/clarification outcome, observed empty-result boundary, then recorded performance observations.
- [x] Describe empty retrieval and fallback as observations, not automatic failures. Label a step slow only against a documented threshold; otherwise show the longest recorded span.
- [x] Use provider-reported usage where available. Missing token usage is unknown, not zero. Count actual provider attempts separately from prepared inputs and model responses.
- [x] If cost is shown, record pricing source/version, currency, and applicable token categories. Label it estimated; otherwise show unavailable.
- [x] Add missing request-lifecycle measurements through instrumentation only where needed. Distinguish server first-text emission from browser-observed first-text arrival.

### Acceptance criteria

- A completed request with no verified fulfillment can show `Execution: completed` and `Business outcome: unknown`.
- Each finding opens its supporting card. Unsupported causes are never asserted.
- A truncated report prominently qualifies conclusions and never displays missing usage as zero.
- Request latency comes from a compatible clock boundary, never a sum of child durations.

## 2. Richer cards and step details

Keep cards compact: title, result, one meaningful change or decision, and captured timing. Put detailed facts, evidence links, rules, and source in the inspector.

| Card | Target information | Capture work to verify or add |
| --- | --- | --- |
| Understand the message | Original and normalized text, resolved intent, entities, constraints, ambiguity | Check which normalization and resolution facts survive into production reports. |
| Check language rules | Winner, runner-up, score margin, condition results | Derive margin only for comparable recorded scores. Capture condition outcomes if absent; definitions alone do not prove evaluation results. |
| Find helpful examples | Query, status, count, scores, corpus version, selected examples | Record retrieval identity and model-input references separately; retrieval alone does not prove model use. |
| AI request/response | Model, prompt version, attempts, latency, usage, validation result | Link preparation, actual provider attempt, response, and validation without double counting. |
| Choose execution path | Selected path, recorded reason, condition values, alternatives | Preserve existing route explanations; identify policy alternatives separately from branches actually evaluated. |
| Search catalog | Operation, criteria, returned count, recorded errors | Preserve existing capture. Do not infer an empty-result cause from a count alone. |
| Filter products | Before/after count for each sequential check and rejection reason codes | Extend the current aggregate filter event with bounded per-check facts, preserving check order and business behavior. |
| Request outcome | Requested constraints, delivered result, unresolved constraints, action receipt status | Capture structured task completion facts where available; do not infer mutations from response text. |

### Implementation tasks

- [x] Introduce typed or schema-validated presentation facts and stable evidence references shared by summary, cards, and inspector.
- [x] Extend the existing presentation helpers rather than placing domain-specific interpretation throughout rendering code.
- [x] Add per-filter counts within the existing bounded event where practical to conserve the event budget.
- [x] Label sequential filter counts as ordered effects; they do not establish how each filter would behave independently.
- [x] Link retrieved examples to captured model-input inclusion only when explicit identifiers establish the relationship.
- [x] Keep source SHA, matching rule generation, raw evidence, and unknown-function explanations available.
- [x] Add explicit legacy states for every new fact instead of blank or misleading values.

### Acceptance criteria

- A captured sequence of 12 products, then 3 after price, then 0 after stock renders those exact transitions.
- A legacy aggregate-only filter event shows its aggregate result without invented intermediate counts.
- Rule scores are not presented as calibrated probabilities unless that meaning is explicitly defined.
- Model input preparation, provider success, validation success, and business success remain distinct.
- Concurrent catalog calls retain their own criteria and results.

## 3. Overview, waterfall, and persistent inspector

### Overview

Default to a small set of expandable groups: Input, Interpretation, Decision, Retrieval/tools, Model, and Outcome. Show only recorded groups, preserve repeated occurrences in execution order, and keep every captured event accessible. Groups are navigation aids, not new execution claims.

Add problem navigation for explicit errors, observed empty results, recorded fallback, missing evidence, and spans over a configured duration threshold. Selecting a result reveals the corresponding event and opens its details.

### Waterfall

- Use a shared time axis with bars for measured spans and markers for instantaneous events.
- Show parent-child nesting only when explicitly captured. Timestamp ordering alone is insufficient.
- Show concurrent spans as overlapping bars and retries as distinct linked attempts.
- Display service and operation when recorded; do not infer cross-service work from a function name.
- Keep events without compatible timing in an untimed section. Do not place them at zero.
- Expose inclusive duration. Defer exclusive/self time and critical-path claims until complete relationships justify them.
- For live traces, update the same span when completion arrives; incomplete spans remain running or completion not captured.

### Inspector and navigation

- Use a persistent side panel on wide screens and a readable stacked panel on narrow screens.
- Share selection across overview, waterfall, findings, previous/next controls, and playback.
- Preserve existing request URLs, tenant selection, history filters, pagination, browser Back, and refresh behavior.
- Add optional view/event URL state using stable identifiers without putting payloads or customer text in the URL.
- Preserve keyboard navigation, visible focus, reduced-motion support, and readable text at default zoom.

### Capture and identity tasks

- [x] Reuse existing call IDs within their request scope; add stable event identity and explicit parent references to a versioned capture contract.
- [x] Track parent context safely across nested synchronous and asynchronous calls, concurrent tasks, exceptions, and cancellation.
- [x] Ensure live-start and durable-completion records map to one presentation span.
- [x] Preserve original event order separately from chronological display order.
- [x] Audit existing operational telemetry before reusing its IDs; independent per-report counters must not be assumed to form one span namespace.
- [x] Specify bounded private context at gateway, Python, language-engine and catalog boundaries. Extend service contracts for supported spans; provider server internals and other tool routes remain explicitly unavailable.
- [x] Define clock domains explicitly. Do not combine unrelated monotonic offsets across services without a supported alignment method.
- [x] Deliver the measured Python waterfall first. Untimed and incompatible-clock evidence remains separate; connected service spans remain M4.

### Acceptance criteria

- Nested and concurrent fixtures render the correct overlap and explicit hierarchy.
- Repeated calls to the same function stay distinct; live completion does not duplicate a card or lose selection.
- Missing parents caused by truncation remain visible as incomplete relationships.
- Older untimed reports remain navigable without fabricated bars.
- At 390, 768, 1024, and 1512 pixels, navigation and inspector content remain usable without shrinking all card text to fit.

## Delivery sequence

| Milestone | Deliverable | Exit condition |
| --- | --- | --- |
| M0: Contract and fixtures | Evidence inventory, additive capture schema, stable identity rules, representative sanitized fixtures | Existing versus missing evidence is documented; outcome and clock semantics are agreed in the implementation design. |
| M1: Summary and existing facts | Diagnostic summary, deterministic findings, richer cards using current reports | Summary/card acceptance criteria pass for existing evidence and legacy captures. |
| M2: Capture enrichment | Parent references, lifecycle measurements, model metadata/usage, per-filter counts, explicit completion facts | New fields survive storage, redaction, export, and live delivery within capture budgets; disabled capture remains disabled. |
| M3: Overview and waterfall | Expandable overview, measured Python waterfall, shared inspector, problem navigation | Nested/concurrent/live/legacy fixtures and responsive navigation checks pass. |
| M4: Connected boundaries and rollout | Cross-service context where supported, service lanes, rollout verification, operator documentation | New traces demonstrate linked boundaries with valid timing; unsupported boundaries are explicit. |

M1 can ship independently. M3's hierarchy depends on M2. Cross-service instrumentation is a separate slice of recommendation 3 and must not delay improvements backed by current reports.

## Validation plan

Extend existing journey, presentation, server, diagnostics, tracking, and browser suites. Use meaningful behavioral fixtures rather than tests that only repeat formatting logic.

Required scenarios:

- Deterministic success without a model call; model fallback with retries and validation failure.
- Function return without verified action success; denial; clarification; explicit failed tool call.
- Empty retrieval versus unavailable retrieval; examples retrieved but model inclusion unknown.
- Sequential product filtering; nested and concurrent calls; exception and cancellation paths.
- Running live spans transitioning to completion; repeated function names; missing parent.
- Legacy captures; partial timing; redaction; truncation; expired or unavailable reports.
- Tenant isolation, permission revocation, audited export, and capture disabled.
- Request deep links, selection on refresh, browser Back, keyboard controls, and mobile layouts.

Baseline commands, run from the repository root during implementation:

```sh
node --test rengine/tests/*.test.mjs
node --check rengine/public/app.js
node --check rengine/public/journey.js
node --check rengine/public/journey-presentation.js
node rengine/tests/browser.mjs
```

Run the affected Python suites using the repository's supported Python environment, including diagnostics, live tracking, tracking persistence, and telemetry when changed. Add gateway/language contract checks if service propagation changes. Browser suites require the existing Playwright setup.

Measure capture overhead and report size on the same representative workload before and after instrumentation changes. Record the baseline and agree a numeric regression budget before shipping M2; do not claim zero overhead. Verify both capture-enabled and capture-disabled behavior.

## Compatibility and rollout

1. Deploy the gateway reader accepting report versions 1 and 2, then the compatible rengine reader, before enabling v2 writers. The older gateway rejects v2 reports.
2. Ship UI-only improvements against current reports.
3. Deploy instrumentation to one demo and verify new captured evidence, size limits, permissions, and disabled-capture behavior.
4. Deploy compatible instrumentation to remaining demos and verify one representative trace per demo.
5. Enable the overview/waterfall after its required evidence is verified; preserve raw evidence as a fallback.
6. Update the rengine README to distinguish supported boundaries from future capture work.

Python capture changes require the assistant deployment; rengine deployment alone cannot create new evidence. Gateway and language instrumentation require their corresponding deployments. Keep changes additive so reverting the UI or capture producer leaves saved reports readable. Do not backfill unobserved facts into old reports.

## First implementation slice

The rengine Overview, Waterfall, Cards and shared inspector are deployed, together with compatible v1/v2 gateway readers. The M4 candidate demonstrated gateway dispatch, language and catalog links with independent remote clocks, but its producer rollout failed the live capture-overhead gate and was rolled back. Before another producer release, profile capture and persistence costs, measure SSE `done` separately from connection EOF, then rebase on the latest production language/knowledge release and rerun the exact-runtime and live canaries. Do not include the unpublished producer overlay in unrelated releases. See [M4 rollout verification](../tracing-rollout.md).

Definition of done for the overall plan: all three experiences are implemented, new evidence is captured and versioned where needed, legacy reports remain useful, authorization and redaction are preserved, and the validation and rollout evidence is recorded.
