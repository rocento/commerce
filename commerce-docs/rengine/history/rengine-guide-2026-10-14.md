# rengine

> Historical snapshot retained on 2026-10-14. UI descriptions, deployment identities and validation results apply to their recorded milestones; later source changes supersede the Waterfall/side-inspector layout. Use the [current rengine guides](../README.md), [usage](../usage.md), [operations](../operations.md) and [rollout gates](../tracing-rollout.md) for new work.

rengine is the separate shopping-assistant diagnostics service at **https://rengine.rocento.com**. It connects to Grocery, Jewelry, Electronics and Pharmacy. Deploying the lab itself does not restart commerce or AI services; changes to Python capture instrumentation require the separate assistant deployment.

Production status (2026-10-11): the updated rengine UI and compatible gateway readers are live. The capture-v2 Python/language producer was rolled back after its latency canary failed; new production reports remain on the prior producer until that gate is resolved. Existing v1 reports and saved v2 canary reports remain readable. Explicit done/EOF timings and lighter service health probes are deployed; the latest producer retry still missed the unchanged latency gate. See [rollout results](../tracing-rollout.md).

## Using the lab

The login form opens automatically when there is no active operator session. Sign in using the configured rengine operator (the production Grocery bootstrap administrator); no demo selection is required. The connected indicator opens Settings instead of asking for another login. Login and session restoration update the selected demo, Settings, health and visible history immediately, without a page refresh. Saved demo accounts then reconnect automatically; no separate login is needed for each demo. **Settings** provides write-only password entry to verify, save, replace or remove each account. Saved credentials use AES-256-GCM encryption with a separately mounted key. They survive deployments and restarts. API responses contain account metadata, never passwords or upstream cookies.

The operator gate is checked against the Grocery gateway on every protected operation and requires wildcard administrator permission. Operator sign-in remembers this browser for 30 days using an HttpOnly, same-site persistent cookie (Secure over HTTPS). The encrypted remembered-session file survives service restarts; it stores hashed browser tokens, the operator's login credentials and upstream session cookie. Expired operator authentication renews using that browser's authenticated credentials, with administrator permission checked again. Sign out deletes the remembered session; expired or revoked operator access requires another login. Ordinary demo-only sessions remain limited to two hours and do not survive restarts. Ordinary demo tracking accounts retain access only to demos they explicitly log into and cannot read or change saved accounts. Each saved demo's permissions are checked independently; expired upstream connections renew automatically, with a 30-second retry cooldown for failed credentials.

- **Request explorer:** run language interpretation, inspect normalization and semantic matches, click through rule scores and action graphs, and optionally carry returned context into the next request. Export a result as JSON.
- **Full assistant · guest:** send one real request through the selected gateway and assistant. Inspect SSE events, total time, first-event time and first-text time. These runs may invoke the configured provider and incur its normal usage. They deliberately send no customer identity, admin cookie, mutation payload or explicit confirmation. Customer-only flows remain subject to guest admission. This is not an authenticated checkout test.
- **Recorded journeys in Production traces:** full assistant tests automatically open the recorded request journey, with bounded retries while the report saves. You can also filter by request UUID and select its View action. Select connected steps to view evidence, captured Python source, and matching rule definitions. Play, pause, or step through the sequence.
- **Performance lab:** submit up to 20 language cases, repeated one to three times. Use one request per line with optional `| EXPECTED_INTENT`, or import a JSON array of `{text, context?, expectedIntent?, expectedStatus?}`. Requests are sequential with 250 ms pacing and a 90-second overall deadline. Results include release identity, per-request status, engine-reported latency and measured round-trip p50/p95/p99. Accuracy requires explicit expectations; failed requests with expectations count as failures. Runs without expectations remain unscored. Request rate includes pacing and is not a maximum-throughput measurement.
- **Production traces:** filter by period, outcome or exact request UUID; browse with keyset pagination; and inspect actual language, retrieval, model, routing and response evidence. Request links include the owning demo (`?store=grocery&request=UUID`) and reopen after sign-in. Reports show capture version, redaction, truncation and model-input availability. Refresh updates both the list and the selected report. **Export JSON** requires `assistant.tracking.export` and uses the gateway’s dedicated audited export endpoint. Access remains tenant scoped and reads are audited by the existing gateway. Reports may be disabled, expired or truncated. Captured stage data does not include invented per-stage durations.
- **System map:** an interactive conceptual guide to the complete request cycle. It is labeled separately from observed traces.

At most two evaluations run across the service and one per browser session. Cancel stops capture and subsequent benchmark requests; an already dispatched assistant turn may still finish. Imported cases and exports stay in the browser unless submitted for evaluation. There is no persistent rengine database or stored test history; keep exported runs to compare releases later.

The former demo-admin tracking page, navigation, component and dedicated frontend client have been removed. Manage rengine read/export grants through demo roles under **Analytics & reports → rengine diagnostics**. Backend tracking contracts and audit events remain because rengine uses those secured APIs.

## Enable or disable execution tracing

In **Production traces**, use **Enable tracing / Disable tracing** for the selected demo. Reading the setting requires `assistant.tracking.read`; changing it also requires `assistant.settings.write`. Gateway permission checks and an audit record apply to every change. The switch is saved atomically in that installation's persistent assistant settings volume and survives restarts.

Changes apply to new turns immediately, without a restart. Active turns retain the mode selected at their start. With capture off, no diagnostic context, function-source inspection, detailed timing, debug files or tracking report writes are performed. Normal assistant messages and basic operational metrics continue. Existing reports remain readable until their normal expiry. A small settings-file stat and disabled-context check remain; this is not a zero-overhead claim.

The deployment's `AI_INTENT_TRACKING_ENABLED=false` is an upper-level lock: rengine cannot override it. A malformed or unreadable saved setting disables capture and is shown as unavailable. `AI_INTENT_DEBUG_DIR` cannot override the disabled runtime switch.

## Journey evidence

Message details now begins with a diagnostic summary: interpreted customer goal, execution status, conservative business outcome, and findings linked to supporting cards. Completed execution does not establish fulfilled shopping intent. Capture-v2 reports include the application's completion-policy result; older reports can still show an unknown business outcome despite successful-looking replies or handler completion markers.

Measurements and capture completeness are available in a disclosure. Capture v2 records Python turn duration, server text-event creation timing, and OpenAI Responses dispatch counts and validated usage. Failed-attempt usage remains unknown, and embeddings are outside these totals. Older reports expose only captured language-model response subtotals. Missing usage is never displayed as zero. Gateway/browser end-to-end latency and versioned cost remain unavailable. Errors, empty results, fallback, and the longest recorded span are observations with explicit limits, not AI-generated root-cause claims.

Language, rule, model, retrieval, filtering, and terminal cards include additional structured facts where recorded. Capture v2 adds bounded per-check product counts, explicit links to examples inserted into prepared model input, provider prompt/schema fingerprints, and adapter-validation outcomes. These remain separate from model execution and shopping success. Overview groups expand to show every recorded event. Waterfall shows measured Python spans, concurrent overlap, explicit parents, and event markers; incompatible or missing timing stays in an untimed section. Cards preserves the previous zoomable timeline. All views share a sticky inspector on wide screens and a stacked inspector on narrow screens. Problem navigation links findings, missing evidence, and spans above an editable inclusive-duration threshold (default 1,000 ms). Selection and view are retained on refresh and encoded as `event` and `traceView` URL parameters; payloads are never added to these parameters. Live renderer updates retain the selected span identity. M4 adds explicitly linked gateway dispatch, language-handler and catalog-handler evidence in service lanes. Each remote duration retains its own clock; cross-service alignment and critical-path analysis remain unavailable. Provider internals and other tool routes remain unsupported. See the [canary rollout guide](../tracing-rollout.md). See the [evidence contract](../tracing-evidence-contract.md) and [implementation plan](../tracing-improvement-plan.md).

New Python reports capture monotonic event offsets, selected function-call durations and source snapshots with file, line, SHA-256 and a source identifier. Shared source is stored once per report; functions over 24,000 characters are marked as excerpts. No parameters or local variables are automatically captured. Sources pass through existing report redaction and remain restricted to administrator tracking access. Source hashes identify the original captured code; displayed source can be redacted. Python call durations include nested work and waiting and must not be summed. This is selected-boundary instrumentation, not a profiler of every function or database query. Reports retain the existing one-megabyte budget, with up to 96 events and an explicit truncation flag.

The language adapter captures the actual successful response's candidates and release identity. `node rengine/pack-rules.mjs` packages intent definitions from the compiled dictionary; the deployment wrapper runs it automatically. rengine only joins definitions when the recorded generation fingerprint matches that artifact. Definitions from another generation are never substituted. Database-backed rules are evaluated from the compiled in-memory dictionary; a rule node does not claim a live SQL query occurred. Older reports can still be inspected, but missing source/timing cannot be reconstructed. A source or rule definition unavailable in a report is clearly labeled.

For capture v2, deploy the gateway reader accepting report versions 1 and 2, then rengine, before deploying Python capture changes. The old gateway rejects v2 reports. Verify one demo first, then deploy the remaining assistants; use the smoke script's `--journey` flag to verify new captures. Implementation alone does not change already-running services.

## Source and local development

[Service source](../../../commerce-web/apps/rengine) is a standalone Node 22.18+ application using only built-in modules; no package installation is required. It serves its own UI and calls fixed, operator-configured upstream origins. Browsers cannot supply upstream URLs.

```sh
node rengine/pack-rules.mjs
node rengine/server.mjs
```

Open http://127.0.0.1:3190. `HOST` defaults to loopback, `PORT` to 3190 and `RENGINE_ORIGIN` to that HTTP origin. Configure each demo using `RENGINE_<STORE>_GATEWAY`, `RENGINE_<STORE>_LANGUAGE` and `RENGINE_<STORE>_ASSISTANT`. Names are uppercase, for example `RENGINE_GROCERY_LANGUAGE=http://127.0.0.1:3187`. Local default language ports 3187/3287/3387/3487 and assistant ports 8000–8003 are development placeholders: override them for the services actually running.

The production [Compose service](../../../commerce-ops/compose/compose.rengine.yaml) joins the four assistant-private networks, the four commerce networks for gateway access, and its own edge network for host ingress, and binds its HTTP listener only to `127.0.0.1:3190`. It runs unprivileged with a read-only application filesystem and one writable encrypted-connection data directory, memory/CPU/PID limits, no added capabilities and no database credentials. [Nginx](../../../commerce-ops/deploy/rengine/nginx.conf) supplies TLS, same-host routing and login throttling.

## Verification

```sh
node --test rengine/tests/*.test.mjs
node --check rengine/public/app.js
bash -n deploy/aws-deploy/deploy-rengine.sh scripts/ec2-deploy-rengine.sh
docker compose -f commerce-ops/compose/compose.rengine.yaml config --quiet
# Uses the existing frontend Playwright installation and Chromium:
node rengine/tests/browser.mjs
node rengine/tests/sidebar-browser.mjs
```

Automated server tests cover authorization, demo isolation, permission revocation, CSRF, closed upstream requests, statistics, guest credentials and logout. Browser checks cover request/benchmark/trace interactions, the semantic graph, and mobile overflow using synthetic upstream fixtures. CI runs the server and source/configuration checks.

## Interface conventions

The workspace uses self-hosted Source Sans 3 (SIL Open Font License), a compact white sidebar with vertically stacked icons and labels, the Core Admin light gray workspace (#f8f8f7) and coral actions and separate green, amber and red status treatments. Font assets and their license are served by rengine without a third-party CDN. Shared styles live in `rengine/public/style.css`.

Production traces combines authorized demos into one newest-first, paginated grid, with a demo label on every message and an optional demo filter. Partial outages and capture ON/OFF are shown per demo. Pagination keeps per-demo buffered cursors in the operator session (12 recent page cursors); refresh if an older page expires. Requests are already captured by each assistant while rengine is closed, subject to the existing capture switch, report size limits and retention. Opening the dashboard queries those reports; it does not duplicate them into a second history database. Each available report has a View action that opens a dedicated message-details screen with its own URL. Back to history and browser Back restore the existing filters and page within the current session. The message-details screen opens an Overview and provides a request sidebar for Execution timeline, AI & reasoning, Catalog & evidence, Issues, and Raw trace. The selected section and evidence restore from the URL after refresh. On mobile, these sections become a horizontally scrollable navigation row. Execution timeline uses only Cards, including when opening older view links. Selected step details appear underneath the cards across the full content width. It has one numbered timeline arranged across three balanced rows, read left to right and then top to bottom, containing every recorded step, including Python functions. Each card has a title, category, a step-specific status (such as “Function finished,” “AI input prepared” or “Request completed”) and captured timing. Function completion is distinguished from the overall request outcome; raw technical values remain in the evidence. Selecting a card opens its details below. The timeline opens at readable full size with horizontal scrolling across three rows. Zoom in/out, 100% and Fit to screen control the flow canvas while details remain at normal size. Previous/Next, playback, keyboard arrows and horizontal scrolling follow the same sequence on desktop and mobile. Retrieval, model, rule/decision and final-response boundaries have distinct labeled card styles. Retrieval distinguishes returned examples, empty results, unavailable service and unconfigured retrieval; missing events remain “Not recorded,” and retrieved examples do not establish downstream model use. Step explanations appear only in the full-width details panel below the cards, alongside structured facts above raw evidence.

Function source, rules and evidence use the recorded journey step inspector; raw stage payloads remain available in a disclosure. The journey is derived from the same authorized report read.

Production traces identifies the selected demo above its capture controls. The top bar reports the number of connected demo sessions. Navigation includes a skip link and current-page state, and request evidence tabs support arrow keys, Home and End. Browser regression checks cover all four workspaces at 390, 768, 1024 and 1512 pixels, font loading and keyboard tab selection.

## Production deployment

The Cloudflare record `rengine` points to the current Rocento host and uses the existing wildcard origin certificate. Deploy from the repository root:

```sh
bash deploy/aws-deploy/deploy-rengine.sh
```

This uploads only rengine source, its Compose file, its dedicated Nginx site and its deployment script. The server uses the existing deployment lock, preserves the prior image/source/site, builds the service, waits for health, validates Nginx and reloads it. Failure restores the prior service image/site when available. Backups live under `/var/backups/rocento/rengine/`. The dedicated Nginx site survives normal commerce site regeneration. Full uploads also retain rengine source; deploy the service separately after changing it.

On the server:

```sh
cd /opt/rocento
docker compose -f commerce-ops/compose/compose.rengine.yaml ps
docker compose -f commerce-ops/compose/compose.rengine.yaml logs --tail 100
curl --fail http://127.0.0.1:3190/health
```

After deployment, verify HTTPS, unauthorized API rejection, each demo's login/permission boundary, readiness, and a synthetic language request. A healthy rengine process does not establish the health of its upstream demos; the UI checks those separately.

## All-demo smoke check

From the workstation, run the operator smoke script against the existing host:

```sh
ssh -i deploy/aws-deploy/rocento.pem -o BatchMode=yes ubuntu@3.78.102.161 'sudo python3 - --journey' < scripts/check-rengine.py
```

The script reads protected administrator credentials on the server, never prints them, and signs out afterward. It checks each demo’s readiness, a language request, an explicitly scored one-case benchmark, trace-list access and a guest assistant request. The guest request can incur normal provider usage. It performs no authenticated shopper or order mutation.

## Saved connection deployment

The narrow deployment creates `/opt/rocento/deploy/rengine-private/` outside the application source. `operator.env` sets `RENGINE_OWNER_STORE` and `RENGINE_OWNER_EMAIL`; it contains no password. `key` is a 32-byte encryption key, mounted read-only at `/run/secrets/rengine-key`. `data/connections.enc` and `data/connections.enc.sessions` are atomically replaced with mode 0600. The latter stores remembered operator sessions and must be preserved with the matching key across deployments. The data directory and key are owned by container UID 1000; the host parent is root-only. Deployment backups include this protected directory. Restore the data and its matching key together; a missing or incorrect key fails closed. Never commit, print or copy these files into public artifacts. Changing operator identity requires editing the protected environment file and restarting rengine.

Validation: `node --test rengine/tests/*.test.mjs`, `node rengine/tests/browser.mjs`, and `node rengine/tests/connections-browser.mjs`.

Timeline badges use full words: Input (formerly IN), Decision (IF), and Function (FN). Decision identifies a captured check or routing boundary; it does not assert that a specific Python `if` statement ran. Short traces use up to three rows. Fit, zoom, playback and click-to-inspect remain available for saved journeys.

Timeline explanations name the purpose of each currently instrumented function, including execution-path selection, interpretation checks and store operations. Function completion is explained separately from action success; a returned function does not prove a cart change or other task succeeded. Execution-route and handler steps show their recorded path, reason and task. Unrecognized functions are explicitly marked as lacking a documented explanation rather than guessing from their names.

Timeline colors consistently identify step categories and are explained by a visible legend. Every card uses its category tint, including when selected or failed. Selection uses a dark outline. Separate text badges show results: confirmed request completion is green, errors are red, missing or unavailable results are amber, and ordinary function completion is neutral. The final-outcome category itself does not imply success.

Catalog call details: new assistant captures attach the operation, selected search criteria (query, category, currency, price bounds, stock and attribute filters), and returned product count to the individual function span. Catalog discovery reports whether a schema was returned. These facts use the existing report redaction and size limits; credentials, identities, complete product results and exception text are not added. Nested and concurrent spans retain separate details. Older reports keep the generic label and explicitly identify missing catalog details. Deploy both the Python assistant and rengine for new captures to show this information.

Execution-path decision details show the selected path in plain language and compare the rule-driven, existing-handler and core paths. Explanations are derived from the recorded reason and routing policy; unselected paths are not represented as executed attempts, and unknown reasons remain explicitly unexplained.

Catalog cards distinguish Search by text from Search with filters using the recorded criteria. A wildcard query without filters is Browse catalog. New catalog_filter events show Filter returned products with before/after counts and the checks applied inside the assistant, without a new catalog request. These are separate from catalog search calls; older captures do not acquire invented local-filter steps.
