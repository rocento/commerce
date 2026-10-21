# Configuration and operations

[Python Settings](../../commerce-assistant-platform/app/commerce_action_engine/platform/settings.py) is the canonical environment contract. Saved admin provider settings can override provider configuration; dataclass defaults alone do not describe a deployed tenant.

| Setting | Purpose / constraints |
| --- | --- |
| `ASSISTANT_TENANT_ID`, `ASSISTANT_PUBLIC_KEY_FILE` | Required together for infrastructure enablement; tenant must be a UUID |
| `ASSISTANT_COMMERCE_URL` | Must equal `http://assistant-tools:8081` |
| `AI_LANGUAGE_ENGINE_URL` | Reachable Node interpretation service |
| `AI_LANGUAGE_GENERATION_FINGERPRINT` | Optional expected dictionary fingerprint |
| `AI_LANGUAGE_RUNTIME_SHA256` | Optional exact Node parser runtime hash; requires verifiable version 2 provenance |
| `AI_MODEL_PROVIDER`, `AI_MODEL_NAME`, `AI_MODEL_KEY_FILE`, `AI_MODEL_URL` | Model configuration; provider defaults to disabled |
| `AI_MODEL_TIMEOUT_SECONDS` | Provider timeout; default 20 seconds |
| `AI_MODEL_MAX_CALLS_PER_TURN` | 1–4, default 2; UNKNOWN fallback still makes one proposal attempt |
| `AI_MODEL_DAILY_TOKEN_BUDGET`, `AI_MODEL_SESSION_TOKEN_BUDGET` | Nonnegative usage budgets |
| `AI_MODEL_INPUT_MICROS_PER_1K`, `AI_MODEL_OUTPUT_MICROS_PER_1K` | Nonnegative usage accounting prices |
| `AI_SMALL_MODEL_NAME`, `AI_SMALL_MODEL_INPUT_MICROS_PER_1K`, `AI_SMALL_MODEL_OUTPUT_MICROS_PER_1K` | Optional small-model configuration; name required for its flag |
| `AI_STORE_PASSWORD_FILE` | Separate AI-store secret |
| `AI_STORE_HOST`, `AI_STORE_USER` | Default `ai-postgres` / `ai_runtime`; shared mode permits `shared-ai-postgres` and a demo-specific `ai_runtime_<store>` login |
| `AI_PROVIDER_SETTINGS_FILE`, `AI_ACCEPTANCE_FILE`, `AI_EXACT_POLICY_FILE` | Managed settings, acceptance artifact and exact-policy input |
| `AI_EMBEDDING_MODEL`, `AI_KNOWLEDGE_COLLECTIONS` | Retrieval configuration |
| `AI_INTENT_EXAMPLE_COLLECTION` | Separate approved interpretation-example collection |
| `AI_SEMANTIC_RECOVERY_EMBEDDING_BUDGET` | 0 or 1; default 0 |
| `AI_FEATURE_FLAGS`, `AI_CORE_JOURNEYS` | Comma-separated validated allowlists |

Supported feature flags are `catalog_singleflight`, `catalog_cache`, `small_model`, `typed_errors`, `grounded_intent`, `commerce_core`, `commerce_meaning`, `commerce_planning`, `compound_execution` and `semantic_read_recovery`. They do not replace request admission or gateway authorization. Semantic example recovery must satisfy its configuration and read-only admission checks.

## Operator intent debugging

The **Production traces** workspace at [rengine](https://rengine.rocento.com)
provides the operator workflow for all four demos. Tracking has been removed from
the demo admin UI; the secured gateway APIs remain shared with rengine. New turns are captured to the AI database by default
when storage is configured. `AI_INTENT_TRACKING_ENABLED=false` disables database
capture; rengine still lists existing turn metrics. The per-demo **Enable tracing / Disable tracing**
control also disables detailed capture, including optional local-file capture. Run AI migration `008_assistant_tracking.sql`
before activating the updated service. Fresh-store initialization and
`commerce-ops/scripts/conversations-setup.py --container AI_POSTGRES_CONTAINER` include it.
The standard EC2 AI deployment migration step uses that same script.

Access requires `assistant.tracking.read`; JSON export additionally requires
`assistant.tracking.export`. Grant these only to intended operators through the
existing admin role editor. Each list/detail/export request is audited in the
commerce admin audit log using actor and request identity, without prompt contents.
The gateway uses a dedicated signed `tracking_read` scope on the private AI ingress;
shopper tokens cannot read reports. Read responses are private and never cached.

The rengine recorded-journey view shows captured execution evidence for the selected
request. See [journey evidence and capture limits](../rengine/usage.md#journey-evidence).
The Production traces page supports period/outcome filters, exact request-ID lookup, keyset pagination,
request links, stage inspection and JSON export. Model calls include provider JSON,
classification instructions/schema, retrieval query/examples, proposal and final
decision. Reports have a 7-day read lifetime and are purged by regular store
maintenance and on report insertion. Historical metrics remain available when no
report was captured. Request capture errors do not fail the customer response.

Classification sends compact examples containing only `utterance`, `intent` and
`canonical_text`. The `intent_retrieval` stage retains complete source/review
metadata, scores and fingerprints; the classification/provider stages show what
was actually sent. Projection preserves wording and applies the original three
example / 6,000-character admission limits to complete evidence. The three-field
proposal schema, 2,048-token output ceiling and deterministic validation are
unchanged. The condensed instructions retain all allowed intent codes and the
conversation, literal-preservation and context rules. Compare model-reported
input/output tokens and accepted/clarified outcomes on the same held-out requests
when evaluating token savings and classification quality; prompt character counts
are a size comparison, not a token-usage measurement.

The local paired classification canary is `commerce-ops/scripts/classification-canary.py`.
Its default dry run makes no API calls:

```sh
commerce-assistant-platform/.venv/bin/python commerce-ops/scripts/classification-canary.py \
  --output output/intent-debug/classification-canary-dry-run.json
```

The frozen baseline contains only the previous classification instructions and
schema. Ten authored cases use identical model/schema/output limits and fixed
approved examples in both variants; apple/dinner are known training controls.
This is a small diagnostic comparison, not a blind accuracy benchmark or a test
of retrieval recall. It compares proposal semantics and constraint preservation
separately from fresh offline language-engine acceptance. Recognized requests are
marked as forced classification because production normally skips the model.

A live run requires `--live --provider-settings PRIVATE_PROVIDER_SETTINGS_FILE`
and explicit approval to send the internal prompts/schema and synthetic fixtures
to OpenAI. No keys are printed or written to reports. The existing live-canary
budget wrapper limits the run to 20 calls and USD 0.25; the first provider error
stops the run without retries. Incomplete runs publish no overall token-saving
percentage. Model-reported input totals include cached tokens; the current usage
contract does not expose cache billing details. No commerce tools are offered or
executed. A live classifier run does not deploy any service changes.

Quality rules choose status before intent: a denied desire without a positive
request clarifies; conditional requests clarify; jokes use a conversation intent
with JSON `null` canonical text. Positive search filters are preserved. A preserved
filter can still require clarification when the deterministic engine cannot verify
it. Conversation codes cannot masquerade as `INTERPRETED` commerce proposals.
Conditional write and bare denied-desire proposals are rejected before engine
revalidation, even if a model preserves their original wording.

`evals/classification-quality.en.json` provides five targeted synthetic checks.
Use `--variant compact --dataset commerce-assistant-platform/evals/classification-quality.en.json`
for a current-prompt-only check. `--prior-report PREVIOUS_LIVE_REPORT` deducts all
previous calls and reservations, including failed calls, from the original budget;
each source report permits one continuation in its directory. This flag accounts
for an existing approval; it does not grant approval or retry a stopped request.
Targeted results report their small selected scope, with no paired savings claim.

Invalid structured responses add a private `provider_invalid_response` stage
when operator capture is enabled. It includes the parse phase, at most 16 KiB of
model output, at most 16 validation issue types/locations, and separately labeled
unverified provider token counts. Exception messages, validator input/context,
headers and the raw HTTP body are excluded. Public errors remain generic and
invalid JSON is never repaired or streamed to the customer.

Database reports redact credential keys, common token/credential patterns, emails
and telephone-like sequences. Redaction is best effort, not proof that all personal
data has been removed. The inspector labels its content as redacted; access to these
short-lived reports remains restricted. Anonymous shopper turns are captured too.
The local-file mode below preserves the original data and is for private diagnostics.

Set `AI_INTENT_DEBUG_DIR` to an absolute writable directory to capture new turns as
`<request-id>.json` and `<request-id>.html`. It is disabled when unset. The local
assistant Compose overlay passes this variable through; use
`/var/lib/assistant-config/intent-debug` inside that deployment's existing writable
configuration volume, then copy reports out with `docker compose cp` using the
same project and overlays as the running stack. Restart/recreate the AI service
after changing its environment. For a native development process, use an absolute
directory under `commerce-assistant-platform/local`.

Open the HTML report to inspect the customer request, initial language result,
retrieval query, complete selected examples and scores, classification input and
schema, model response/proposal, and final routing result. OpenAI-compatible calls
also capture the exact JSON provider payload, excluding HTTP headers and credentials.
The final record contains the displayed answer. Deterministic turns have no model
request; reports cannot reconstruct earlier turns or an unavailable retrieval index.

Reports are operator files, never added to public SSE events, conversation metadata,
or performance logs. Files use owner-only permissions, HTML content is escaped,
and captures are isolated per request and capped at 32 records/1 MB of event data.
Truncation is explicit. Capture-write failures leave chat running. Reports contain
customer text and context, so enable capture for a short diagnostic session, keep
the directory private, delete reports when finished, and unset the variable.

Python defaults to eight active turn slots and a 25-second turn deadline; these dataclass fields have no matching environment overrides. [The Python Dockerfile](../../commerce-assistant-platform/Dockerfile) runs as user 10001 with Uvicorn transport concurrency 16 and keep-alive timeout five seconds. It installs the hashed `requirements.lock` and exposes port 8000.

Never pass `DATABASE_URL`, `AUTH_SECRET`, `POSTGRES_PASSWORD`, `S3_SECRET_KEY`, `PAYMENT_SECRET` or `ASSISTANT_PRIVATE_KEY_FILE` to Python; Settings rejects these general Commerce credentials.

## Persistence and language releases

[AI migrations 001–007](../../commerce-assistant-platform/migrations) cover base storage, deployment boundaries, knowledge, conversations, indexes, request revisions and compound plans. [Conversation setup](../../commerce-ops/scripts/conversations-setup.py) and existing deployment tooling own provisioning. Language dictionary database migrations and authoritative Rust receipts have separate ownership.

Node `HOST` and `PORT` select its binding. `ENABLE_DURABLE_SESSIONS=true` enables session routes only when a trusted tenant resolver and database are supplied. `PENDING_SESSION_TTL_SECONDS` defaults to 1800. Session cleanup runs every five minutes.

Language package scripts support migration, compilation, artifact verification, release export and activation. Inspect their source and target environment before publishing a release. For compatible language-contract changes, deploy and verify Node before dependent Python changes. Compare `/api/health` fingerprints and `/api/ready` with the expected artifact, then Python `/ready`, followed by authenticated commerce acceptance.

Compound execution requires both `commerce_planning` and `compound_execution`, necessary delegated read/write capabilities and persistence. Gateway write delegation additionally requires `ASSISTANT_COMPOUND_WRITES_ENABLED=true`. Preserve receipt recovery for previously started operations during rollback.

## Troubleshooting

For disabled Python readiness, inspect the paired tenant/key inputs and managed settings. For resolver readiness failure, verify the address, Node contract self-check, loaded artifact and fingerprint pin. For history/feedback or receipt failures, check the separate AI store and migrations. For denied commerce operations, check signed identity and delegated scopes at the gateway. For model-unavailable results, use the explicitly scoped provider test and inspect configured budgets. Do not enable fallback to work around parser outages.

Production health and tenant activation were not reverified during this rewrite. Use [the deployment runbook](../../commerce-ops/deploy/ec2/README.md) and record fresh environment-specific acceptance evidence before claiming rollout success.

## Language runtime provenance

Version 2 language responses must match Python's packaged dictionary fingerprint.
Set optional `AI_LANGUAGE_RUNTIME_SHA256` to the intended deployment bundle's
`identity.runtimeSha256` to additionally require that exact Node parser build.
Enabling it also rejects legacy responses without verifiable runtime metadata.
`AI_LANGUAGE_GENERATION_FINGERPRINT` may further pin the dictionary fingerprint,
but cannot override the packaged-artifact check. See the
[language release upgrade runbook](language-release-upgrade.md) for rollout and
rollback ordering, release identities and the two span encodings.
