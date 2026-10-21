# API coverage and reference access

The complete private [OpenAPI contract](../../commerce-api/rocento-api/openapi.json) documents the gateway's application operations. Infrastructure and crawler document routes use the deliberate exceptions below. Axum's implicit HEAD handling for GET is not a separately declared operation. Optional feature routers remain in the inventory even when an installation has not enabled their feature.

The [generated inventory](../../commerce-api/rocento-api/api-documentation-inventory.json) records every method/path, owning source file, documentation audience, reference placement and exception. Its `counts` object is the source for current registered, full-contract, public, merchant and audience totals; do not copy those totals into maintained prose. The [review policy](../../commerce-ops/scripts/checks/api_documentation_policy.json) lists exact method/path pairs: adding a route never silently makes it public or silently classifies it as internal.

| Reference | Access and purpose |
| --- | --- |
| Public storefront/customer | [Public API reference](https://rocento.com/docs/api/); reviewed storefront functions and customer-owned resources |
| Merchant | Administrator session plus `api.docs.read`; includes the public operations, reviewed merchant administration and the mixed media metadata representation |
| Internal | Repository-only engineering reference for assistant, agent, publication, mobile and operational contracts; the inventory records each operation's exact audience |

Repository access is the internal reference's documentation access boundary. This includes native push registration, enrolled mobile sessions, App Studio catalog previews and fixed preview-worker lifecycle controls. Their first-party credentials and deployment bindings do not establish a public integration contract. There is no unauthenticated full-schema HTTP endpoint and no separate operator documentation portal. Do not copy the full contract or this inventory into website/admin static assets. A future operator portal needs its own operator identity and authorization before hosting these references.

Documentation audience is distinct from runtime authorization. Some internal first-party routes legitimately accept anonymous or guest requests; others require customer sessions, merchant permissions or delegated service proofs. Calling them still follows their handler's actual authorization policy. Hiding documentation cannot make an API secure, and permission to read documentation never grants permission to execute a documented operation.

The merchant schema is served by `GET /v1/admin/api-reference/openapi.json` behind the installation's existing administrator session validation and the explicit `api.docs.read` permission. Responses, including denials, use `Cache-Control: private, no-store`; a static viewer does not contain the schema. The handler uses its provisioned installation database pool and accepts no database, tenant, host or schema selector. Provisioning must maintain the required separate database for each merchant; the documentation feature does not provision or migrate tenant databases.

## Non-OpenAPI protocol exceptions

| Registered route | Contract and owner |
| --- | --- |
| `GET /health` | Process health JSON (`{"status":"ok"}`); gateway health tests |
| `GET /metrics` | Prometheus text protocol; managed public ingress blocks it, operational scraping uses the gateway directly |
| `GET /robots.txt` | Crawler text policy generated for the installation |
| `GET /llms.txt` | Installation public-discovery text, subject to publication settings |
| `GET /sitemap.xml` | Sitemap XML document/index |
| `GET /sitemaps/{partition}` | Partitioned sitemap XML |

The deployment renderer also has one explicitly inventoried `fallback(shell)` in `discoverability.rs`. It returns installation-bound negotiated publication representations for site paths; it is not a finite named API operation. See [public publication](publication.md) for the renderer and crawler contracts. Every exception has an explicit policy reason; new exceptions require review.

## Keep references complete without publishing new routes by accident

1. Update the owning contract extension and run `python3 commerce-ops/scripts/contracts/generate_openapi.py`.
2. Review authentication, tenant/customer scope, sensitive schema fields and the intended audience. Update the exact operation and schema allowlists in the [public generator](../../commerce-ops/scripts/contracts/generate_public_openapi.py) or [merchant generator](../../commerce-ops/scripts/contracts/generate_merchant_openapi.py) only when appropriate.
3. Add the exact method/path to the reviewed policy. Internal operations still need an accurate full-contract definition; they are not an escape hatch for missing documentation.
4. Regenerate both projections, then run `python3 commerce-ops/scripts/checks/check_api_documentation.py --write`. This writes the private inventory and its counts only after route coverage, audience policy and all three references agree. Keep private paths explicitly excluded in the public generator as well as classified in the policy.
5. Run `python3 commerce-ops/scripts/checks/check_api_documentation.py --check` and `python3 -m unittest discover -s commerce-ops/scripts/tests -p 'test_api_documentation.py'` with the public and merchant projection checks in CI.

The scanner rejects unknown routes, method changes, removed routes with stale references, unreviewed fallbacks and unsupported router syntax. It handles explicit Axum registrations and local literal path constants; it is a source coverage guard, not a compiler or proof of endpoint authorization. Extending route construction syntax requires extending and testing the scanner before the route can pass. Source coverage does not establish live deployment availability.
