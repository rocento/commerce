# Using rengine

Use rengine to inspect language interpretation, measure bounded requests and read authorized assistant reports. This guide reflects the source reviewed on 2026-10-14; see [rollout status](tracing-rollout.md) for the last recorded production state and [operations](operations.md) for setup.

## Sign-in and connections

When there is no operator session, the login form opens automatically. Sign in with the configured rengine operator, which is the production Grocery bootstrap administrator in the recorded deployment. The connected indicator opens Settings. Sign-in and session restoration update demo selection, health and history without a page refresh.

Settings lets the operator verify, save, replace or remove demo accounts through write-only password fields. Saved accounts reconnect automatically and each demo's permissions are checked independently. Credentials are encrypted with AES-256-GCM and a separately mounted key; API responses expose metadata, never passwords or upstream cookies. Failed renewals have a 30-second retry cooldown.

The Grocery gateway checks wildcard administrator permission on every protected operator action. Operator sign-in remembers this browser for 30 days through an HttpOnly, same-site cookie, Secure over HTTPS. Encrypted remembered sessions survive service restarts; renewal rechecks permission using that browser's credentials. Sign out deletes the remembered session. Ordinary demo-only sessions last at most two hours, do not survive restarts, and cannot manage saved accounts.

Manage diagnostic read/export grants in demo roles under **Analytics & reports → rengine diagnostics**. The former demo-admin tracking page was removed; the secured gateway tracking APIs and audit events remain in use.

## Workspaces

| Workspace | Use and limits |
| --- | --- |
| Request explorer | Inspect interpretation, normalization, matches, rule scores and action graphs. Carry returned context into a later request and export JSON. |
| Full assistant · guest | Send a real request through the selected gateway/assistant. View SSE events, first event/text, `done` and stream-EOF timing. It may incur normal provider usage; it sends no customer identity, admin cookie, mutation payload or explicit confirmation, so it is not authenticated checkout acceptance. |
| Performance lab | Run up to 20 language cases one to three times, sequentially with 250 ms pacing and a 90-second overall deadline. Results show release identity, status, engine latency and measured round-trip p50/p95/p99. The paced request rate is not maximum throughput. |
| Production traces | Read tenant-authorized saved requests, inspect recorded evidence and export through the dedicated audited endpoint. A report can be disabled, expired or truncated. |
| System map | Explore the conceptual request cycle. The map is distinct from observed trace evidence. |

Performance cases accept one line per request with optional `| EXPECTED_INTENT`, or a JSON array of `{text, context?, expectedIntent?, expectedStatus?}`. Accuracy requires explicit expectations; a failed expected request counts as a failure, while a run without expectations is unscored.

At most two evaluations run across the service and one per browser session. Cancel stops capture and later benchmark requests; an already dispatched assistant turn may finish. Imported cases and exports stay in the browser unless submitted for evaluation. rengine has no separate report database or persisted benchmark history: preserve exports when comparing releases. Assistant reports remain in their owning service.

## Production traces and message details

The message grid combines authorized demos newest first and labels every row with its demo. Filter by demo, period, outcome or exact request UUID. Partial outages and capture settings are shown per demo. Pagination keeps 12 recent page cursors per operator session; refresh if an older page expires.

Select **View** to open message details. Guest tests open the recorded journey automatically with bounded retries while it saves. Links include `?store=grocery&request=UUID` and reopen after sign-in. Back to history and browser Back restore filters and the current page within the session. Refresh updates both list and selected report.

New message details open on **Execution timeline**. The other sections are **Overview**, **AI & reasoning**, **Catalog & evidence**, **Issues**, and **Raw trace**. The selected section and event restore from the URL. Navigation becomes a scrollable row on small screens.

The execution timeline uses **cards**, including when an old `traceView` link requests Waterfall. Read left to right across up to three balanced rows, then top to bottom. Every recorded step remains accessible. Select a card to open full-width details underneath it; explanations and structured facts appear before raw evidence. Source and rule disclosures are available only when the report recorded them.

Cards open at readable full size with horizontal scrolling. Use Zoom, 100%, Fit to screen, Previous/Next, playback and keyboard navigation to follow the same sequence. Category color identifies the kind of work; the separate status label describes the result, and an outline marks selection. **Function finished**, **AI input prepared** and **Request completed** express different outcomes. Input, Decision and Function badges do not claim an uncaptured Python statement ran.

The implementation is owned by [page navigation](../../commerce-web/apps/rengine/public/app.js), [section labels](../../commerce-web/apps/rengine/public/index.html) and [the journey renderer](../../commerce-web/apps/rengine/public/journey.js). Historical Overview/Waterfall and side-inspector descriptions remain in [history](history/README.md).

## Enable or disable execution tracing

Use **Enable tracing / Disable tracing** in Production traces for the selected demo. Reading needs `assistant.tracking.read`; changing the setting also needs `assistant.settings.write`. Gateway permission checks and audit records apply. Export separately requires `assistant.tracking.export`.

The setting is saved atomically in that installation's persistent assistant settings volume and survives restarts. New turns use a change immediately; active turns keep the mode selected at their start. With capture off, detailed diagnostic context, source inspection, timing, debug files and tracking report writes stop. Ordinary messages and operational metrics continue; existing reports remain readable until expiry. A small settings-file stat and disabled-context check remain.

`AI_INTENT_TRACKING_ENABLED=false` is an upper-level deployment lock. A malformed or unreadable saved setting disables capture and is shown as unavailable. `AI_INTENT_DEBUG_DIR` cannot override disabled runtime capture.

## Journey evidence

Keep interpreted customer goal, execution status, business outcome and capture completeness distinct. Function completion and a successful-looking reply do not establish fulfilled shopping intent. Findings link to supporting recorded steps; missing information remains unknown. Unknown functions and reasons remain explicitly unexplained.

Measurements depend on report version. Capture v2 can include application completion-policy results, Python turn duration, server text-event creation timing, provider dispatch counts and validated usage. Failed-attempt usage stays unknown and embeddings are outside these totals. Older reports expose only what their producer captured. No version invents gateway/browser latency, provider internals, versioned cost or missing timing; see the [contract](tracing-evidence-contract.md).

Catalog steps distinguish text search, filtered search and wildcard browsing from local filtering. Where captured, inspect operation, selected criteria, returned count and per-check before/after counts. These facts do not include full products, credentials or automatic locals/arguments. Retrieval, inclusion in prepared model input, provider execution, adapter validation and shopping success are separate facts.

Python source snapshots include file, line, SHA-256 and source identity, deduplicated within a report. Functions over 24,000 characters are excerpts. Sources pass through report redaction and require administrator tracking access; the hash identifies original captured code even if displayed text is redacted. Instrumentation covers selected boundaries, not every function or database query. Inclusive durations can overlap and must not be summed. Reports retain the one-megabyte and 96-event bounds, with explicit truncation.

Rule definitions are joined only when the recorded generation fingerprint matches the artifact packaged by `node commerce-web/apps/rengine/pack-rules.mjs`. The actual successful language response supplies candidates and release identity. Database-backed rules run from the compiled in-memory dictionary; a rule card does not imply a live SQL query. Missing historical source, timing or rule definitions cannot be reconstructed.
