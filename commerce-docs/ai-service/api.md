# API reference

The Python API is normally called through the authenticated Rust gateway. The authoritative route implementations are [chat](../../commerce-assistant-platform/app/commerce_action_engine/application/api/chat.py), [history](../../commerce-assistant-platform/app/commerce_action_engine/application/api/history.py) and [system](../../commerce-assistant-platform/app/commerce_action_engine/application/api/system.py). Use the generated FastAPI `/docs` interface for current request/response schemas in a running development instance.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health` | Process liveness |
| GET | `/ready` | Enabled identity, language compatibility and configured AI-store readiness |
| POST | `/v1/chat` | Gateway-authenticated bounded SSE turn |
| GET | `/v1/history` | Owned conversation history with signed history scope; optional conversation ID |
| POST | `/v1/delivery-event` | Save delivery-selection confirmation with dedicated signed scope |
| POST | `/v1/feedback` | Feedback on an owned response; storage required |
| GET | `/v1/insights` | Tenant insights with metrics scope |
| GET | `/v1/metrics` | Scoped stored metrics |
| POST | `/v1/metrics/ack` | Scoped metric acknowledgement |
| GET / POST | `/v1/provider-settings` | Scoped provider configuration read/write |
| POST | `/v1/provider-settings/test` | Explicit provider connection test |
| GET | `/v1/provider-settings/readiness` | Baseline dependencies and readiness |
| POST | `/v1/provider-settings/acceptance` | Scoped acceptance probe with supplied catalog query |

Python POST bodies are limited to 16 KiB. Chat checks identity, conflicting contexts and concurrency before streaming. Refer to [event serialization](../../commerce-assistant-platform/app/commerce_action_engine/application/api/events.py) and [action contracts](../../commerce-assistant-platform/app/commerce_action_engine/contracts) for current SSE contracts. Clients must distinguish presentation events, action receipts and stream termination. History text must not retrigger actions such as checkout.

`/ready` asks Node `/api/ready` to verify its parser contract. Missing, incompatible or unavailable language readiness and a failed configured store return 503. An optional generation fingerprint pin checks the expected language artifact. A ready response can still report model unavailability and is not an end-to-end commerce acceptance result.

## Node resolver

[Node server](../../commerce-assistant-platform/app/commerce_language_engine/src/server.ts) exposes:

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/resolve` | Resolve `{text, context}` into the interpretation contract |
| GET | `/api/health` | Dictionary version, contract version, counts and generation fingerprint |
| GET | `/api/ready` | Fixed `show my cart` self-check, requiring a resolved VIEW_CART action |
| POST | `/api/sessions` | Create an optional durable context session |
| POST | `/api/sessions/:id/resolve` | Resolve with a positive current session revision |
| POST | `/api/sessions/:id/cancel` | Cancel with a positive current session revision |

Resolver requests are capped at 32 KiB, text at 4,000 characters, and context is validated against the loaded dictionary. Session routes return 404 unless durable sessions are enabled and require a trusted tenant resolver; arbitrary client identity is insufficient. Stale revisions return 409 and expired/cancelled sessions return 410. The Node parser does not execute commerce actions.
