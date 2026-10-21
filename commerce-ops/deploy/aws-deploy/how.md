# Deployment operations notes

Production promotion requires a reviewed, root-owned release packet and exact
preverified application images/frontend artifacts. Missing evidence blocks
source activation and deployment; production no longer rebuilds these artifacts.
Complete the [release authorization procedure](../../../commerce-docs/platform/operations/release-readiness.md#enforced-production-promotion)
before invoking the commands below. Build and qualify candidate artifacts separately.


For the complete, current command reference, see [Deployment commands](README.md), including fast AI/language deployments and per-store options.

```bash
cd /Users/momar/Documents/commerce-ai
bash commerce-ops/deploy/aws-deploy/deploy.sh
```

Run these commands on your Mac. Cleanup runs automatically on EC2 before the
disk check, under the deployment lock. The uploader includes `commerce-ops/deploy/ec2/server/cleanup.py` with the server source;
credentials remain excluded from the source upload.

Production uploads exclude the entire root `Rocento-Codex/` workspace, including
large Quality datasets, reports and checkpoints. Before uploading, the launcher
removes only the old `/opt/rocento/Rocento-Codex` copy on production. Local files
and the separate `/opt/rocento-quality/Rocento-Codex` test workspace are preserved.

The source scan is limited to application/deployment directories and Compose files.
Demo images/presets, documentation, local workspaces, and generated Language Engine
research data are excluded. The language runtime receives its compiled dictionary
and packaged release; frontend public assets remain included. Use the separate
seed launcher for demo assets. Unchanged files are skipped by rsync, including on
reruns after an interrupted deployment. Transfer statistics and elapsed upload
time are printed for each run. Preview pending source updates and migration
removals without writing to EC2 or starting deployment:

```bash
bash commerce-ops/deploy/aws-deploy/deploy.sh --dry-run
```

The preview requires an existing remote checkout. It omits protected configuration
contents and cannot be combined with local language export options.

During activation, the server synchronizes canonical `commerce-*` source paths
with `ubuntu:ubuntu` ownership under the deployment lock. Protected runtime
configuration and state under `/opt/rocento/deploy/ec2/`, including secrets,
generated configuration, `setup.lock`, and seed markers, remain separate from
uploaded source.

Cleanup keeps the active frontend release and two newest rollback copies.
Older managed releases are removed. Retain approved frontend exports outside
the server if you need to restore a version older than those rollback copies;
production recovery republishes that approved export rather than rebuilding it.
It also removes known mypy, pytest and Ruff caches, frontend test reports,
pnpm's local stores, source-tree dependency folders, Next.js intermediates and TypeScript build metadata
from the checkout. Those caches, reports, `node_modules/` and local `.venv/`
folders are excluded from upload. Runtime dependencies remain inside Docker
images and persistent application data remains in Docker volumes.
When space is low, `apt-get clean` clears downloaded package caches without
uninstalling packages.
If fewer than 30,000 MiB remain, unused Docker build cache older than 24 hours
is pruned. If space is still below the threshold, a second pass removes all unused
build cache regardless of age. That cache is shared by the host, so later builds may take longer.
If space is still low, untagged Docker images older than 24 hours that are unused by any container are pruned. Tagged images, recent images, and images referenced by running or stopped containers are retained. Volumes, databases, uploads, containers, source and secrets are retained.
Verify-only runs skip cleanup. If disk space is still insufficient, deployment
stops and EBS must be expanded; the disk check is not bypassed.

Use `bash commerce-ops/deploy/aws-deploy/deploy.sh` for application deployment. It never seeds demo
data, bootstraps/enforces demo administrators, or updates demo theme colors.
The launcher still targets its configured server.

For demo data, run separately from your local checkout after deploying:
`bash commerce-ops/deploy/aws-deploy/seed-demo.sh --store all`.
Replace `all` with `grocery`, `jewelry`, or `electronics` for one store.
The launcher connects with `commerce-ops/deploy/aws-deploy/rocento.pem`, uses the protected bootstrap
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

Run deployments from this updated `/Users/momar/Documents/commerce-ai` checkout.
Deploying an older checkout or deliberately rolling back can restore older code.

Category-image seeding runs only when demo seeding is enabled. Only missing
thumbnails and banners are filled; existing images and attributes are preserved.
When images are missing, set the existing GROCERY_ADMIN_EMAIL/PASSWORD and
JEWELRY_ADMIN_EMAIL/PASSWORD credentials in protected commerce-ops/deploy/aws-deploy/bootstrap.env.
Completed assignments are reused. Image seeding uses verified
local HTTPS, does not reseed products, and does not run in verify-only mode.

Egyptian delivery inventory is seeded for Grocery, Jewelry and Electronics.
See [Frontend documentation](../../../commerce-docs/frontend/assets-and-demos.md) for areas, source
allocation, safe reruns and full-cycle scenarios. Existing five demo areas migrate
from default stock to city stock; their IDs and geometry are retained. If custom
coverage exists, all existing areas and stock links are preserved: enrichment
stocks demo products in enabled sources linked to active areas without adding
new areas, stocks or sources. Invalid links or an active area with no enabled
source stop inventory writes with an actionable error. Theme colors are independent.

Company contact form: copy commerce-ops/deploy/aws-deploy/contact.env.example to commerce-ops/deploy/aws-deploy/contact.env,
set CONTACT_SMTP_PASSWORD to the info@rocento.com mailbox password and chmod 600
the file. The launcher securely installs it outside the web root. The form at
/about/#contact sends Sales, Support, Demo request and Partnership enquiries to
info@rocento.com, with the visitor as Reply-To. SMTP credentials never reach the
browser. Namecheap Private Email uses mail.privateemail.com with verified TLS
on port 465. The endpoint limits submissions to 30 per hour across the site.
Without credentials it returns an unavailable error and offers direct email.
After deployment, submit a test enquiry and confirm it arrives in the mailbox;
SMTP acceptance alone does not prove inbox placement.

First electronics release: add Cloudflare `electronics` and `electronics-admin` records pointing at the existing EC2 server and set `ELECTRONICS_ADMIN_EMAIL` / `ELECTRONICS_ADMIN_PASSWORD` in the protected `commerce-ops/deploy/aws-deploy/bootstrap.env`. Run `bash commerce-ops/deploy/aws-deploy/deploy.sh`, then separately on EC2 run `sudo bash /opt/rocento/deploy/ec2/server/ec2-seed-demo.sh --store electronics`.

## SSH upload timeout

The local deploy script gives SSH, rsync and scp a 20-second connection timeout,
up to three connection attempts, and keepalive probes every 15 seconds. These
settings help transient connection failures; they cannot open a blocked port.
A failure during source upload stops the script before remote activation.
Rerun from the same local checkout when SSH is reachable:

```sh
ssh -i commerce-ops/deploy/aws-deploy/rocento.pem -o BatchMode=yes -o ConnectTimeout=10 ubuntu@3.78.102.161 'printf "SSH reachable\n"'
bash commerce-ops/deploy/aws-deploy/deploy.sh
```

If SSH still times out, confirm that the instance is running, its public IP is
still the configured address, and its security group permits TCP 22 from your
current public IP. Also check local VPN/firewall connectivity. Keep this access
restricted to your IP. Connection retries do not retry the remote deployment
command after it has started.

The launcher also shares one authenticated SSH connection across its commands
and uploads. Network-interrupted rsync/scp transfers are retried at most three
times; rsync retains partial files for resumption. Non-network transfer errors
fail immediately. Errors identify the deployment stage. The remote deployment or
seed command is never automatically retried, since it may already have changed
services or data.

A timeout immediately after `Connecting to ubuntu@3.78.102.161` occurs before
source upload. Demo seeding is never part of this launcher; run the standalone
EC2 seed command separately after a successful deployment.

Read-only diagnostics on 2026-09-17 confirmed intermittent SSH connectivity:
five of six bounded connection checks succeeded, and one timed out. Disabling
SSH packet prioritization also timed out, so that setting is not a confirmed
fix. On successful checks, SSH was active, UFW inactive, and the inspected SSH
journal had no MaxStartups drops. The exact network cause remains unresolved;
no production deployment or seed was run during these diagnostics.


## Gateway startup: migration VersionMismatch

A successful image build and agentic contract preflight do not compare SQLx
migration contents against the deployed database. If the gateway exits with
`VersionMismatch(20260922120000)`, the capacity migration was edited after
being applied. The three EC2 stores' original migration was recovered and
verified against their recorded SHA-384 checksum on 22 September 2026.

The repair restores `20260922120000_fulfillment_capacity.sql` exactly and adds
`20260922121000_fulfillment_capacity_extensions.sql` for settings, overrides,
reservation timezone backfill, historical address retention and indexes.
Existing reservations take their schedule's timezone; capacity defaults off.
Do not modify `_sqlx_migrations`, reset databases or remove volumes to bypass
this error. Redeploy from the repaired checkout:

```sh
bash commerce-ops/deploy/aws-deploy/deploy.sh
```

The launcher now includes the gateway's recent log when Compose startup fails.
The repair was checked on disposable PostgreSQL for both an upgrade with an
existing reservation and a fresh installation through all 55 current migrations.
Reproduce that check with `python3 commerce-ops/scripts/checks/check-capacity-migration-upgrade.py`;
`python3 -m unittest commerce-ops/scripts.tests.test_capacity_migration_history` protects the
original migration checksum. These local checks do not establish EC2 recovery;
a successful deployment and its readiness checks establish that separately.

Earlier isolated M10 snapshots containing the edited original migration retain
their historical source/checksum. They are not silently reconciled by this fix;
keep their evidence intact and use a fresh disposable database for a new rehearsal.

## Duplicate migration version after a renamed source file

On 22 September 2026, the server retained the obsolete
`20260922150000_fulfillment_plans.sql` alongside the current
`20260922150000_market_commerce.sql` and
`20260922160000_fulfillment_plans.sql`. The general source upload had preserved
files removed or renamed locally. SQLx applied market commerce, then the
second migration at that version failed with a duplicate history key;
subsequent startup reported a version mismatch against the stale file.
The successfully applied market-commerce checksum matches the current source.

The deployment launcher now excludes migrations from the general upload,
copies the existing remote migration directory into
`/home/ubuntu/.rocento-migration-backups/<run>/`, and mirrors only
`commerce-api/rocento-api/migrations/` with deletion of obsolete source files. This affects no
Docker volume or database record. Backup is a separate remote copy because
the macOS openrsync backup/delete combination did not remove obsolete files
in the regression rehearsal.

Before building or replacing any application containers, `ec2-up.sh` now
rejects duplicate migration versions and compares all applied migration
checksums for all three existing stores. Missing, changed or unsuccessful
applied migrations stop deployment. A new PostgreSQL installation without
migration history is handled separately. `commerce-ops/scripts/checks/check-migration-history.py`
also runs standalone for local inventory checks or a saved read-only history.

Use the normal `bash commerce-ops/deploy/aws-deploy/deploy.sh` command from this updated checkout.
Do not delete migration history or manually retry an already applied SQL file.
