# API contracts and request admission

[backend/openapi.json](../../commerce-api/rocento-api/openapi.json) is the complete generated API contract for development and generated clients. Its generator and source extensions live under [openapi](../../commerce-api/rocento-api/crates/api-gateway/openapi). The gateway does not serve this internal file; managed public ingress also blocks `/api/openapi.json`. The complete contract must not be copied into a public website or exposed through a new proxy. Axum routers and domain validation remain the source for behavior; schema generation alone does not implement an endpoint.

Browser clients normally call `/api/v1/...`; development and ingress strip `/api`, leaving gateway `/v1/...`. Do not add a second `/api` prefix inside Rust route definitions. `/health` is process liveness; `/ready` checks authoritative database/schema readiness and registered worker task health. Worker status is `running`, `not_configured`, or `unavailable`; a running task may still be retrying an unavailable dependency. Metrics are exposed separately at `/metrics`.

Customer endpoints derive owned scope from verified bearer identity. Admin endpoints use the existing authenticated session, current role permissions and mutation safeguards, including origin checks and the `X-Commerce-Request: 1` marker where required. Request bodies cannot grant tenant/admin ownership. Domain writes validate current facts and their revision/idempotency contracts independently of UI validation.

Catalog reads accept `X-Storefront-Locale` for reviewed translations; it does not select a currency or change prices. Product, product-family, bestseller and search reads accept optional customer bearer authentication for personalized offers. Anonymous requests remain valid, but an invalid supplied bearer token returns 401. The operation security alternatives explicitly describe both cases.

`AUTH_IP_RATE_LIMIT_MODE` defaults to `peer`, applying the gateway's shared authentication throttle to the actual connection peer and ignoring forwarded IP headers. Use `ingress` only for gateways accessible through an ingress that enforces client-IP limits; it transfers this HTTP-level throttle to ingress while preserving all account-level limits. Managed EC2 ingress limits authentication attempts by client IP and hostname, exempts refresh/logout, and returns JSON 429 responses with `Retry-After`. It accepts Cloudflare client-IP headers only from the published Cloudflare proxy networks. Deployment activates those limits before starting gateways in ingress mode.

API families cover identity, catalog/search, attributes, cart/checkout/orders, inventory/delivery/fulfillment, customer support, themes/CMS/localization, markets, segments, grids/exports/reports, public publication and assistant delegation. Exact operation schemas and security requirements belong to the generated contract and router.

Password hashing and verification have a process-wide execution and waiting budget. Admission exhaustion returns JSON HTTP 503 with `Retry-After: 3`; it does not report incorrect credentials. Account and IP throttle responses retain their existing HTTP 429 behavior. Stale proposal classification uses typed checkout causes; legacy status/body and opt-in assistant failure decoration remain compatible.

Application routes also return JSON 503 with `Retry-After: 3` when HTTP admission is saturated or the handler exceeds its pre-response deadline. Database pool, lock or statement admission failures use the same retry delay. These responses are explicit in every application operation contract; `/ready` retains its separate dependency-status 503 schema. The publication snapshot also retains its endpoint-specific plain-text 503. After a timeout, a client must reconcile mutation state or replay the same supported idempotency key: the response does not prove rollback. The HTTP deadline ends when response headers are produced; streamed bodies use their endpoint-specific budgets.

Public support creation, assistant chat, all assistant-memory operations and analytics ingestion have shared 15-minute admission windows. A decodable customer bearer token selects the customer quota; otherwise a server-issued cookie identifies the visitor. This identity grants no endpoint authority. Requests still undergo normal authentication and live-session checks, and an admitted request can consume quota even when its handler rejects the request.

| Operations | Customer/visitor limit | Direct-source limit | Installation default | Visitor cookie |
| --- | ---: | ---: | ---: | --- |
| `POST /v1/support/tickets` | 20 | 100 | 2,000 | `support_guest` |
| `POST /v1/assistant/chat` | 120 | 480 | 3,000 | `assistant_visitor` |
| `/v1/assistant/memory` and its child operations | 120 | 600 | 12,000 | `assistant_visitor` |
| `POST /v1/analytics/events` | 1,000 | 4,000 | 100,000 | `analytics_visitor` |

The four installation totals are configured by `PUBLIC_SUPPORT_TOTAL_LIMIT`, `PUBLIC_ASSISTANT_TOTAL_LIMIT`, `PUBLIC_MEMORY_TOTAL_LIMIT` and `PUBLIC_ANALYTICS_TOTAL_LIMIT`. Subject and installation budgets are stored in PostgreSQL across replicas. In `peer` mode the gateway also applies the direct-source budget; `ingress` mode delegates source throttling to trusted ingress. Quota exhaustion returns JSON 429 and `Retry-After: 900` before invoking the handler. Preserve visitor cookies for their issuing installation; rotating them does not bypass source or aggregate admission. New admission cookies are HttpOnly, SameSite=Strict, Path=/, valid for 24 hours and Secure in secure-cookie deployments. They are separate from customer access credentials and the guest-cart cookie.

## Public API reference

The corporate website publishes a preview reference at `https://rocento.com/docs/api/` using a reviewed subset of the existing OpenAPI contract. OpenAPI remains the source format and self-hosted Swagger UI renders it. This fits the existing generated contract and gives readers searchable request and response schemas without operating a separate documentation server.

[scripts/generate_public_openapi.py](../../commerce-ops/scripts/generate_public_openapi.py) selects an explicit allowlist of operations and only their referenced components, then writes [the public contract](../../commerce-corporate-site/public/docs/api/openapi.json). New backend routes are private by default; adding a route to the backend contract does not publish it. Public selection requires review of descriptions, request and response fields, examples, authentication requirements and every transitively referenced schema. Internal assistant delegation, merchant administration and operational endpoints are excluded.

This is a reference preview, not a stable third-party API program. Customer bearer identities and merchant sessions are application credentials; the platform does not currently offer a documented public API-key or OAuth client-credentials flow. Agree the tenant, permitted operations, credential provisioning and compatibility expectations with the platform team before integrating. Never present browser session tokens as permanent integration keys.

The public viewer pins Swagger UI to `5.33.1` and serves its assets locally. It disables operation execution, credential persistence, URL-based configuration and remote specification validation. The documentation must not accept or store access tokens or run API requests against production. The full contract remains a private repository artifact; it is not served through merchant authentication. Restricting the reference is defense in depth; endpoint authorization, tenant isolation, input validation and throttling remain backend responsibilities.

## Merchant reference and complete inventory

The store admin has **System → API reference**. Both navigation and the server require `api.docs.read` (View API documentation). Existing super-admin `*` includes it; no other role receives the permission automatically. The grant permits reading documentation only, and cannot authorize an operation shown in it.

`GET /v1/admin/api-reference/openapi.json` authenticates the existing HttpOnly `admin_session` and current role in that installation's database on every read. It returns only [the reviewed merchant projection](../../commerce-api/rocento-api/merchant-openapi.json), generated by [generate_merchant_openapi.py](../../commerce-ops/scripts/generate_merchant_openapi.py). Anonymous/invalid/expired sessions and roles without the permission receive no contract. Responses, including errors, are private/no-store with MIME and referrer protections. Requests cannot select a tenant, database, schema file or remote URL.

The admin viewer ships JavaScript/CSS only; never copy the merchant or full specification into an admin public directory, static build, browser storage or service worker. It loads the fixed protected endpoint with a same-origin session, passes the result to Swagger in memory, disables execution/authorization/remote validation/query configuration, and clears/rechecks the contract when the page is hidden or restored. The corporate website stays free of admin credentials. Managed storefront hosts block the merchant reference endpoint; only administration hosts serve it.

Assistant delegation, agent protocols and operational/service contracts remain in the private engineering contract and [API inventory](api-inventory.md). The inventory covers named gateway routes, publication fallbacks and explicit non-OpenAPI operational/discovery exceptions. New routes require an audience decision; they must not silently enter either published projection. Keep the [inventory check](../../commerce-ops/scripts/check_api_documentation.py) in CI. Existing route checks and schemas describe the source version, not a promise of third-party API stability.

Each merchant has its own database/installation. Documentation uses that installation's authentication; no client-provided tenant field changes the database. See [client onboarding](../platform/deployment/client-onboarding.md) for provisioning.

## Contract changes

Edit the owning router/domain and its OpenAPI source extension, regenerate `commerce-api/rocento-api/openapi.json`, then from `commerce-web` run `pnpm generate:api`. Update typed helpers and validations in `commerce-web/packages/api-client`, relevant UI callers and domain/integration checks. Generated `schema.d.ts` should not be edited as the primary source.

After an intentional change to a published operation, regenerate and check the public artifact from the repository root:

```sh
python3 commerce-ops/scripts/generate_openapi.py
python3 commerce-ops/scripts/generate_public_openapi.py
python3 commerce-ops/scripts/generate_merchant_openapi.py
python3 -m pip install -r commerce-ops/scripts/tests/requirements-openapi.txt
python3 -m unittest discover -s commerce-ops/scripts/tests -p 'test_openapi_contract.py'
python3 commerce-ops/scripts/generate_public_openapi.py --check
python3 commerce-ops/scripts/generate_merchant_openapi.py --check
python3 commerce-ops/scripts/check_api_documentation.py --check
python3 -m unittest discover -s commerce-ops/scripts/tests -p 'test_public_openapi.py'
```

Review the resulting public JSON diff alongside the source change. Do not hand-edit the public artifact or automatically widen the allowlist to fix a failed build. CI regenerates the full contract, validates OpenAPI 3.0 semantics, compares all explicit Axum operations against the full contract, rejects stale projections and tests publication boundaries. The exact infrastructure/discovery exclusions and reasons live in `contract_checks.py`; new routes fail coverage until documented or explicitly reviewed. This coverage does not publish an operation. Grids/exports, interface languages, delivery areas, publication snapshots and delegated assistant tools belong to the full contract even when excluded from a public projection. Website build, export and Chromium security checks cover the rendered reference; see [website maintenance](../frontend/website.md).

OpenAPI remains version 3.0.3. Nullable references use a union with an explicit null-only branch: a `$ref` sibling `nullable` is ignored by that dialect, and `allOf` alone cannot make a non-null model nullable. Contract tests validate actual null order fields and reject invalid non-null values; regenerated TypeScript clients preserve those null values. String `maxLength` counts characters, whereas Rust input limits can count UTF-8 bytes. Review/profile schemas give the character upper bound and separately document their stricter byte limits and date validation.

Theme schema generation also derives from [theme-contract.json](../../commerce-api/rocento-api/theme-contract.json); run `node commerce-ops/scripts/sync-theme-contract.mjs` after an intentional theme contract change. Unsupported versions must fail rather than reinterpret old published snapshots.

Assistant tools use fixed delegated capabilities, not unrestricted HTTP access. Python service endpoints have a separate [AI API guide](../ai-service/api.md). Merchant queries remain authenticated bounded read queries; customer model proposals do not authorize backend mutations.
