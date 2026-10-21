# Public publication, discovery and feeds

The gateway assembles typed public snapshots from authoritative active/published commerce records, effective market views, approved media and immutable themes. Node translates those outcomes into merchant document HTTP responses. [Frontend publication](../frontend/publication.md) owns renderer builds and status handling.

Canonical identity binds persisted installation UUID, matching deployment identity, saved merchant origin and approved HTTPS origin. It never derives authority from arbitrary caller headers. Wrong or ambiguous hosts fail. Private/draft/unpublished records cannot become public facts, links, schema or feed entries.

| Source under `commerce-api/rocento-api/crates/api-gateway/src/public_commerce` | Responsibility |
| --- | --- |
| `canonical.rs` | Authority and canonical identity |
| `snapshot.rs` | Public document snapshots |
| `facts.rs` | Allowlisted public product facts |
| `entity.rs` | Merchant identity and content |
| `discovery.rs` | Discovery/public route policy |
| `feeds.rs` | Reference feeds, freshness and withdrawal |
| `attribution.rs` | Allowlisted entry/campaign claims |

Discoverability settings expose effective indexing derived from environment, approved binding and deployment protection in addition to merchant preference. Missing publication environment defaults to development and deployment noindex protection defaults on. Demo/staging/admin protections stay intact. Robots and noindex do not authorize private access; generated structured data does not guarantee indexing, rich results, citations or rank.

Only the configured default content locale is published. Canonical products/categories/CMS use stable identities and slug history; permanent retirement requires explicit approved state rather than treating every missing record as gone. Node uses 404/410/421/503 where appropriate instead of a successful empty shell.

## Feed and media operations

Feeds refresh from current facts using durable generation/cursor/job state, retries and withdrawal tombstones. Monitor freshness, completion age and errors rather than assuming a queued job is delivered. Market changes queue a durable search reindex and public responses use effective availability/prices. Do not discard feed journals during code rollback.

Image derivative refresh uses authenticated `POST /v1/admin/catalog/media/{id}/publication` with catalog write permission. Static PNG/JPEG/WebP media receives compressed WebP candidates at 480 and 960 pixels when the source is large enough, plus its original width. Originals remain available; width requests only serve advertised, stored candidates.

The gateway operator binary `prepare-storefront-images` previews missing or older manifests for publicly referenced media in the configured `DATABASE_URL` installation. `--apply --limit 100` prepares a bounded batch sequentially, with a 5 MiB input limit and a 120-second timeout per image. Private, unreferenced and unsupported media are excluded. The JSON result reports processed/failed IDs and remaining candidates; existing originals remain usable on failure. EC2 full deployments run one batch per store before publishing the frontend. For larger catalogs, repeat the command inside the selected store's gateway container until `remaining` is zero.

Attribution admits only allowlisted claims before supported redirects. Health probes are private and observation tokens never belong in browser builds. Respect scope/retention and avoid customer/credential data in evidence.

## Release checks

Configure `PUBLICATION_ENVIRONMENT`, `PUBLICATION_INSTALLATION_ID`, `PUBLICATION_APPROVED_ORIGIN`, `PUBLICATION_NOINDEX`, matching artifact mounts, private renderer/gateway addresses and observation secret for the identified merchant installation. [Compose publication](../../commerce-ops/compose/compose.publication.yaml) and [EC2 publication tooling](../../commerce-ops/deploy/ec2/publication.py) implement the deployment surface.

Preserved reproduction/deployment code is in [publication tests](../platform/seo-geo/Tests); Markdown reports were removed, while code, manifests and non-Markdown evidence remain. Gateway suites include publication rendering, policy, metadata, discovery, feeds, measurement, release, hardening and migration upgrade.

Before public cutover, verify actual DB/media topology and isolation, matching sealed artifacts, public-edge host/status/headers/robots, private API protection, feed withdrawal/recovery and previous-release rollback. Local fixtures cannot establish external CDN/WAF or storage IAM behavior. Restore the matching gateway/frontend release set while retaining additive schema and commercial state. This rewrite performs no deployment or indexing activation.
