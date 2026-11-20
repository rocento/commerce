# Demo seeding

Demo seeds change catalog and storefront data. Choose the target before running a write command.

## Local demo data

Use the [demo scripts guide](../workflows/demo/README.md) for local database seeds and storefront previews. `seed-demo-storefront.py` previews changes by default; writes require `--apply` and an explicit API base URL. Confirm that URL points to the intended local environment.

## Existing production demo stores

The provider launchers run from your workstation against an existing AWS EC2 or GCP Compute Engine installation. They upload selected seed helpers and data, then update the chosen demo store. They do not deploy platform code. The seed procedure is shared across providers.

```bash
bash commerce-ops/cloud/providers/aws/seed-demo.sh --store grocery
bash commerce-ops/cloud/providers/gcp/seed-demo.sh --store grocery
```

The named-target interface is
`python3 commerce-ops/bin/ops cloud demo seed --target production-aws --store grocery`
or select `production-gcp`. It invokes the matching provider launcher. Local preset preview is
`python3 commerce-ops/bin/ops local demo seed --store grocery`; local writes
require `--apply` and an explicit loopback `--api-base`.

Choose `all`, `grocery`, `jewelry`, `electronics`, or `pharmacy` with `--store`. Use `--delivery-only` to refresh delivery data; `--expand-coverage` requires `--delivery-only`. Review the [AWS launcher guide](../cloud/providers/aws/README.md), [GCP launcher guide](../cloud/providers/gcp/README.md), and selected target settings before running it.

For a platform release, follow [platform deployment](rocento-platform-deployment.md) separately.

## Seed behavior and retained data

For demo data, run separately from your local checkout after deploying:
`bash commerce-ops/cloud/providers/aws/seed-demo.sh --store all`.
Replace `all` with `grocery`, `jewelry`, `electronics`, or `pharmacy` for one store.
The launcher connects with `.local/commerce-ops/secrets/aws/rocento.pem`, uses the protected bootstrap
credentials already on EC2, and uploads the current seeding helpers
and local `commerce-demo/egypt-delivery-areas.json` over SSH
for each run. Helper updates use the deployment/seed lock and stop if another
deployment or seed is active. EC2 validates the area JSON
before any seed writes and uses it for the selected stores' areas, stocks and
sources. Application code is not uploaded or rebuilt; services are not restarted.
Each store uses one admin session for catalog seeding, verification, category
images, delivery inventory and optional Grocery palette synchronization. The
session is logged out when the run finishes or fails. Login rate limits remain
enforced; a rate-limited login is not automatically retried.
Grocery runs also upload `commerce-demo/grocery` and `commerce-assets/demo/Grocery-Items`,
including the 50 white-background product images and their thumbnails. The seed
creates the matching products across eight categories, then deactivates the
previous 50 demo SKUs. Old records, orders and inventory references are retained;
unrecognized catalogs are rejected before writes. Reruns reuse the new products
and media. Use `--store grocery` to refresh just this store. The storefront's new
category navigation and thumbnail rendering require the updated frontend deployment.
An existing deployment is required, but updating these seed helpers does not
require redeployment. The seed command keeps existing assigned themes and targeting
rules while seeding catalog data; a new demo theme is published only for an
unassigned channel. Verification accepts the existing published themes. With
`DEMO_ADMIN_ENFORCE=1`, Grocery palette synchronization still runs for an untargeted
assignment, and skips channels with targeting rules. Customer installations should
leave `DEMO_ADMIN_ENFORCE=0` and avoid running demo seeds.

The production demo updates are saved in this checkout and survive deployment:

- `commerce-demo/grocery/theme.json` defines the refined green `#054828` and
  surface `#F1F4F0`, with success green also `#054828`. For managed demos
  (`DEMO_ADMIN_ENFORCE=1`), the separate seed command checks these tokens when
  Grocery is selected. The color-only
  synchronizer repairs changed tokens through the theme API, preserving layout,
  content, other tokens and theme assignment. Matching themes create no new version.
  Seeding does not reset Grocery's entire theme. Unpublished non-color
  changes that would be unintentionally published, or targeting rules, stop palette
  synchronization for review instead of silently shipping/resetting content.
  `--verify-only` makes no palette changes. Customer deployments with demo mode off
  retain their own colors. See `commerce-docs/platform/demos/grocery-palette.md` for the local command.
- `commerce-api/rocento-api/crates/api-gateway/src/catalog.rs` allows product search and detail
  browsing before a delivery pin is selected. This is application code, so it
  is included in future backend builds for all stores. Customer stores retain
  location filtering; checkout retains its delivery checks.
- Deployments set `DEMO_FULL_CATALOG=false`. Without a location all active products
  remain browsable. Selecting a covered area filters search/category listings to
  products available from its stock pools; checkout enforces local inventory.
- `commerce-web/apps/storefront/src/locations.tsx` explains that choosing a location
  checks local availability and delivery. It is included in frontend builds.
- Products, media and published themes live in persistent storage. Deployment
  cleanup retains that storage; reseeding preserves existing product records.

Run deployments from the updated repository checkout.
Deploying an older checkout or deliberately rolling back can restore older code.

Category-image seeding runs only when demo seeding is enabled. Only missing
thumbnails and banners are filled; existing images and attributes are preserved.
When images are missing, set the existing GROCERY_ADMIN_EMAIL/PASSWORD and
JEWELRY_ADMIN_EMAIL/PASSWORD credentials in protected .local/commerce-ops/secrets/aws/bootstrap.env.
Completed assignments are reused. Image seeding uses verified
local HTTPS, does not reseed products, and does not run in verify-only mode.

Egyptian delivery inventory is seeded for Grocery, Jewelry and Electronics.
See [Frontend documentation](../../commerce-docs/frontend/assets-and-demos.md) for areas, source
allocation, safe reruns and full-cycle scenarios. Existing five demo areas migrate
from default stock to city stock; their IDs and geometry are retained. If custom
coverage exists, all existing areas and stock links are preserved: enrichment
stocks demo products in enabled sources linked to active areas without adding
new areas, stocks or sources. Invalid links or an active area with no enabled
source stop inventory writes with an actionable error. Theme colors are independent.
