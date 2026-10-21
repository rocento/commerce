# Rocento EC2 deployment

Production promotion requires a reviewed, root-owned release packet and exact
preverified application images/frontend artifacts. Missing evidence blocks
source activation and deployment; production no longer rebuilds these artifacts.
Complete the [release authorization procedure](../../../commerce-docs/platform/operations/release-readiness.md#enforced-production-promotion)
before invoking the commands below. Build and qualify candidate artifacts separately.


AI service documentation is maintained in [AI service documentation](../../../commerce-docs/ai-service/README.md).

Canonical workstation launchers live in `commerce-ops/deploy/aws-deploy/`; deployment-host
commands and the EC2 configuration renderer live in `commerce-ops/deploy/ec2/`. On the
server, `/opt/rocento/deploy/ec2/` remains the protected runtime location for generated
configuration, secrets, state and the deployment lock. Server command files are mirrored
there for compatibility with existing service operations. Workstation guides and public
templates live in `commerce-ops/deploy/aws-deploy/`; private configuration remains there. See
the [repository command reference](../../../commerce-docs/platform/reference/scripts.md).

The deployment supports Ubuntu 24.04/26.04 on both x86_64 and ARM64/aarch64 EC2 instances. Docker’s official multi-architecture images build and run natively; the scripts never force `linux/amd64`.

## One-time server configuration

1. Upload this repository to `/opt/rocento`.
2. Create the eleven proxied Cloudflare DNS records: `@`, `www`, `grocery`, `admin`, `jewelry`, `jewelry-admin`, `electronics`, `electronics-admin`, `pharmacy`, `pharmacy-admin`, and `apps`. All must point to the EC2 Elastic IP. Set Cloudflare SSL/TLS to **Full (strict)**.
3. Create a Cloudflare Origin CA certificate covering `rocento.com` and `*.rocento.com`, then save the PEM certificate and matching private key on the EC2 instance. Keep the key outside Git and set mode 600.
4. Create the protected bootstrap file once:

```bash
cd /opt/rocento
install -d -m 700 deploy/ec2
cp commerce-ops/deploy/ec2/bootstrap.env.example deploy/ec2/bootstrap.env
chmod 600 deploy/ec2/bootstrap.env
nano deploy/ec2/bootstrap.env
```

Set the real domain, certificate/key paths, and a separate 12+ character password for each administrator. The script reads this file without shell evaluation, never asks questions, and never logs the passwords.

The EC2 security group must allow TCP 80/443 and SSH from your administrative IP. Keep database and backend ports private; the Compose configuration binds them to loopback only.

## Deploy or resume

```bash
cd /opt/rocento
sudo bash commerce-ops/deploy/ec2/server/ec2-up.sh
```

The script validates prerequisites and reviewed artifacts, installs missing dependencies, creates only missing application secrets, preserves volumes, checks exact approved image IDs, starts the four isolated Rocento demo stores, publishes frontend files atomically, validates Nginx/TLS, then verifies the Cloudflare route. It never seeds demo data, enforces demo administrators, or updates the grocery palette. Logs are written to `/var/log/rocento/deployments/`.

Full deployment automatically initializes each new dedicated language database from the uploaded `compiled.json` and `deployment-release.json.gz`. Before starting the language service, `commerce-assistant-platform/app/commerce_language_engine/scripts/install-empty.ts` creates a missing database, applies all language migrations, imports the verified release and activates its initial baseline. Schema creation, import and activation commit together; a failed installation rolls back and can be retried.

This first-install step skips any database containing application objects, including databases with unpublished drafts or no active release. It never upgrades, overwrites or reactivates existing language data. Existing installations retain the explicit migration/evaluation/promotion workflow in the [language release runbook](../../../commerce-docs/ai-service/language-release-upgrade.md). Normal service startup remains read-only and verifies the selected immutable release and packaged artifact. Migration checksum mismatches block readiness. `--preserve-ai` bypasses the first-install step.

For consolidated installations, use [shared AI database operations](../../../commerce-docs/ai-service/shared-database-operations.md). Shared language upgrades must target all stores; runtime credentials cannot perform operator migrations or release promotion.

The local upload flags retain their CLI names: `--sync-language-data` verifies an existing version 2 database-produced bundle without replacing it, while `--sync-language-db` exports the active local database release. Neither replaces explicit target-side promotion. Use the release runbook to prepare and export an exact candidate.

## Fast AI and language deployments

Use [the workstation command reference](../aws-deploy/README.md#fast-ai-deployment) for accepted flags and examples. This path requires an existing full deployment. It verifies selected preloaded assistant images, takes the deployment lock and waits for readiness without rebuilding Rust or publishing frontend assets.

Use full deployment for gateway/frontend contracts, infrastructure, Compose or ingress changes. A partial deployment checks compatibility with the uploaded gateway contract and does not advance full-deployment fingerprint state.

The corresponding server command is `sudo bash commerce-ops/deploy/ec2/server/ec2-deploy-ai.sh --service all --store all`. Logs use `/var/log/rocento/deployments/ai-*.log`. If a service fails readiness, inspect its logs and active release identity; completed store updates remain applied.

## Seed demos separately

Managed API gateways use `AUTH_IP_RATE_LIMIT_MODE=ingress` and remain bound to localhost. Deployment validates and reloads Nginx client-IP authentication limits before replacing gateway containers, then publishes frontend files after backend readiness and migration checks. Authentication attempts allow 20 requests per minute with a burst of 10 per client and hostname; refresh/logout use their existing session and account protections. Nginx accepts `CF-Connecting-IP` only from the verified Cloudflare networks recorded in `configure.py`; review the linked official IP lists when updating ingress configuration.

Check the generated deployment with `python3 -m unittest discover -s commerce-ops/scripts/tests -p test_ec2_deployment.py`. Native ingress regressions use a disposable Docker Nginx fixture: `AUTH_INGRESS_NGINX_TESTS=1 python3 -m unittest discover -s commerce-ops/scripts/tests -p test_auth_ingress.py`.

From your local checkout, after deploying the updated scripts once:

```bash
bash commerce-ops/deploy/aws-deploy/seed-demo.sh --store all
bash commerce-ops/deploy/aws-deploy/seed-demo.sh --store grocery
```

The local launcher uses the deployment SSH key and runs the seed on EC2 with
the protected configuration already there. It uploads the local
`commerce-demo/egypt-delivery-areas.json` as seed input, validated before changes.
It does not upload application source or deploy. Existing demo boundaries are
preserved, and custom delivery areas still stop the seed rather than being replaced.

After deployment, run explicitly on EC2:

```bash
sudo bash /opt/rocento/deploy/ec2/server/ec2-seed-demo.sh --store all
# Or just one store:
sudo bash /opt/rocento/deploy/ec2/server/ec2-seed-demo.sh --store grocery
```

Supported stores: `all`, `grocery`, `jewelry`, `electronics`, and `pharmacy`. The default is `all`. This command uses the protected bootstrap credentials and the deployment lock. It seeds administrator accounts, catalog data, themes, category images and delivery areas without building, restarting services or rewriting Nginx. With `DEMO_ADMIN_ENFORCE=1`, it enforces demo administrators only for the selected stores and synchronizes the grocery palette only when grocery is selected. Logs are in `/var/log/rocento/seeds/`.

Existing theme assignments and targeting rules remain protected. A conflict stops the seed command, not deployment; resolve the assignment in Admin before retrying. No force-overwrite option is added.

Seeding deliberately uses this path while the temporary mapping exists:

```text
seed script → 127.0.0.1 HTTPS → Nginx → API gateway
```

It retains each public hostname, uses the Cloudflare Origin CA as a *scoped* seed-client trust anchor, retains Secure cookies, and restores `/etc/hosts` even if seeding fails. It never sends the seed request through Cloudflare and never disables TLS verification.

Existing administrator emails must match `bootstrap.env`; the script will fail with the exact remediation if they differ. It verifies actual preset products/theme state before deciding a demo is seeded, rather than trusting a marker file.

## Common modes

```bash
# Health and public-route checks only; does not change services or files.
sudo bash commerce-ops/deploy/ec2/server/ec2-up.sh --verify-only

# Run seed/bootstrap work explicitly on the existing deployment.
sudo bash commerce-ops/deploy/ec2/server/ec2-seed-demo.sh --store all
sudo bash commerce-ops/deploy/ec2/server/ec2-seed-demo.sh --store grocery
sudo bash commerce-ops/deploy/ec2/server/ec2-seed-demo.sh --store jewelry

# Infrastructure/application deploy without demo data.
sudo bash commerce-ops/deploy/ec2/server/ec2-up.sh

# Production artifact policy controls.
sudo bash commerce-ops/deploy/ec2/server/ec2-up.sh --no-build
sudo bash commerce-ops/deploy/ec2/server/ec2-up.sh --restart
```

`--no-build` is accepted for compatibility; every production deployment promotes reviewed, preverified images and a frontend export. `--rebuild` is rejected. A normal rerun checks source fingerprints and exact artifact identities before activation.

## Inspect or diagnose

```bash
sudo bash commerce-ops/deploy/ec2/server/ec2-status.sh
sudo bash commerce-ops/deploy/ec2/server/ec2-doctor.sh

sudo bash commerce-ops/deploy/ec2/server/ec2-compose.sh grocery ps
sudo bash commerce-ops/deploy/ec2/server/ec2-compose.sh jewelry ps
sudo bash commerce-ops/deploy/ec2/server/ec2-compose.sh grocery logs --tail=100 api-gateway
sudo bash commerce-ops/deploy/ec2/server/ec2-compose.sh jewelry logs --tail=100 api-gateway
```

The doctor distinguishes DNS, redirect loops caused by Cloudflare Flexible SSL, Cloudflare 403/1010 responses, origin/Nginx failures, local API readiness, and certificate errors. Never run `docker compose down -v` or a volume-pruning command on this deployment.

The deployment provisions private AI services for each store. In admin, open **System → AI Assistant Configuration**, enter the model and API key, enable the assistant, and save. New installations default to off. Saved changes apply to new conversations without a restart; `ASSISTANT_ENABLED` is no longer required. Settings remain accessible while the assistant is off.

Back up each store's `assistant-config` volume, `commerce-ops/deploy/ec2/<store>-assistant.env`, and `commerce-ops/deploy/ec2/assistant/<store>/` credentials alongside its databases. Preserve these files on subsequent deployments. The AI services have no public ports and each store has its own signing identity, AI database, and settings volume.

The project still runs its gateway in its supported demo notification mode (`APP_ENV=development`, `NOTIFICATION_MODE=console`). Production email delivery remains separate application work; do not use this demo deployment for real customer orders until it is implemented and reviewed.

## First electronics release from an existing two-store installation

Add proxied Cloudflare DNS records `electronics` and `electronics-admin`, pointing to the same EC2 IP. The existing origin certificate must cover these hosts (the wildcard certificate does).
Set `ELECTRONICS_ADMIN_EMAIL` and a unique `ELECTRONICS_ADMIN_PASSWORD` (12+ characters) in the protected local `commerce-ops/deploy/aws-deploy/bootstrap.env`. Keep its existing values and mode 600.

On your Mac:

```bash
cd /Users/momar/Documents/commerce-ai
bash commerce-ops/deploy/aws-deploy/deploy.sh
```

This uploads source, promotes preverified application images and a reviewed frontend export, starts the isolated electronics demo store, and publishes its storefront and admin routes. It does not seed any store. On EC2, run `sudo bash /opt/rocento/deploy/ec2/server/ec2-seed-demo.sh --store electronics` separately to populate that demo. Grocery and jewelry data are preserved. The main website links to `https://electronics.rocento.com`.

Later releases use `bash commerce-ops/deploy/aws-deploy/deploy.sh`. The old `--skip-seed` option remains a harmless compatibility option; `--seed-demo`, `--seed-electronics`, and deployment seed flags now fail with instructions for the separate seed command.

## Separate mobile merchant dashboard

`apps.<domain>` serves the standalone [Mobile App Studio](../../../commerce-docs/mobile/app-studio.md) bundle from `current/mobile-admin`. It has its own login and navigation. The virtual host exposes an explicit mobile-management/identity API allowlist and rejects core administration APIs. The primary gateway origin list includes this host; mobile merchants still require explicit memberships in that gateway. DNS alone does not deploy the UI, migrate the database, or provision memberships.

### AI readiness proxy retirement

Production readiness checks execute directly inside each `ai-service` container and validate both Language Engine and storage readiness. The EC2 overlay disables the unused `ai-health` proxy with the `legacy-ai-health` profile, so normal deployments do not recreate it. The base development Compose configuration retains its local health endpoint for development smoke tests. Do not enable the legacy profile for ordinary production deployments.

The four production proxies were removed after confirming no published ports, no active client connections and no references in the inspected runtime configuration. Assistant, commerce and public-site health checks must continue to use their existing direct readiness paths; removing these proxies does not retire any AI engine or database.

### Private production health dashboard

`https://health.rocento.com` runs independently of the store containers. The frontend lives in `commerce-web/apps/health/`; the authenticated API and Docker health collector live in `commerce-api/health-api/`. Upload those directories and `commerce-ops/deploy/health-dashboard/` to the same paths under `/opt/rocento`, then run `sudo bash /opt/rocento/commerce-ops/deploy/health-dashboard/install.sh`. The installer also accepts the legacy `/opt/rocento/deploy/health-dashboard/` path. Installation holds the deployment lock, validates Nginx, and enables the API plus a one-minute systemd collector timer. Its separate `rocento-health` Nginx virtual host survives normal store configuration generation. Keep these source directories when deploying future repository versions.

Sign in as `info@rocento.com` with the existing **grocery admin password**. Login and every data request use the live grocery admin authentication service; disabling the account or revoking its session also removes dashboard access. The dashboard does not store passwords or have Docker permissions. Its Secure, HttpOnly, host-only cookie is separate from the admin site's cookie. If grocery authentication is down, authenticated dashboard access is unavailable too.

The collector can inspect Docker but only writes sanitized summaries to `/var/lib/rocento-health/snapshot.json`. It samples the expected 62 containers, readiness/catalog reads, eight public HTTPS endpoints, queue ages/failures, stalled exports, reporting freshness, API traffic deltas, and server memory/disk/load. History covers up to 24 hours from installation; the latest 200 resolved incidents are retained. Data older than three minutes is explicitly unknown. Export failure totals are informational; stalled queued/running jobs raise incidents. Dashboard incident notifications are enabled; email and external delivery are **disabled by request**.

Use `systemctl status rocento-health rocento-health-collector.timer`, `journalctl -u rocento-health-collector.service`, and `sudo nginx -t` to diagnose monitoring. The web process is unprivileged and listens only on `127.0.0.1:8099`. Neither service modifies or restarts commerce containers. This is same-host monitoring: add an independent external availability monitor separately to detect whole-host or network outages. It is not a checkout/payment synthetic test or a full tracing/log-search platform.

Engagement publisher health is checked separately from the container heartbeat. Each sample reads the engagement outbox using the retry columns and scans the last two minutes of structured worker logs. Missing schema/database access, unavailable or incomplete logs, retrying events, a pending event aged two minutes, or publisher reconnect/delivery warnings prevent a healthy publisher result. Store badges, aggregate service counts, the service table, and incident history all use this effective health. The service table retains the underlying Docker health for diagnosis. Recovery requires passing checks and a clean two-minute log window. These checks are read-only and do not publish synthetic production events; an idle healthy result means the inspected checks pass, not that a new end-to-end delivery was exercised.

Analytics effective health also checks two-minute warning/error logs and the required `cart-analytics-v1` and `order-facts-v1` JetStream consumers. Missing consumers, unacknowledged redeliveries, or a backlog with no acknowledged progress for two minutes raise incidents. Idle consumers are valid; recreation, acknowledgment progress, or a monitoring gap resets the stall observation. Readiness and the one-hour reporting freshness threshold still apply.

Export effective health adds a live heartbeat/database probe, queue-schema inspection, unexpired failed jobs, ten-minute queue/progress stalls, and two-minute job/queue/spool failure logs. Expired historical failed jobs remain informational. No raw error text or job payloads are exposed. Unavailable/truncated diagnostics yield unknown status. These functional statuses affect worker rows, store badges, totals, and incident recovery without changing worker images or publishing synthetic production events.

Gateway effective health now includes readiness/catalog/queue checks, retrying commerce outbox rows, structured warning/error logs, and required catalog-search/shipment consumers with the same missing/redelivery/no-progress checks as analytics. New sampled HTTP 5xx responses flag the gateway even below the existing error-rate alert's traffic threshold. Counter resets and monitoring gaps establish a new baseline.

AI effective health reads the actual `/ready` dependency body, requires production durable storage and Language Engine readiness, and runs the existing Language Engine parsing/contract readiness check. It checks only the enabled/tenant fields of the existing managed provider configuration, never exports secrets, and distinguishes an intentionally disabled provider from an enabled provider reported unavailable. Runtime diagnostics detect recorded unavailable turns, provider/tool/retrieval/history/persistence errors, server 5xx responses, and Python/Node failures. Only counts and fixed reasons leave the collector. Missing or unrecognized diagnostics are unknown. No model calls, customer prompts, synthetic orders, or writes are performed: provider configuration being valid does not prove external model credentials or network connectivity will succeed on the next request. Existing proxy-container checks remain in place; this is not a full authenticated end-to-end assistant test.


The health dashboard also checks infrastructure independently of container liveness:

- All nine PostgreSQL instances (commerce, engagement, and shared AI): bounded read-only SQL, primary/read-only state, connection use at 85%, lock waits over two minutes, idle transactions over five minutes, and transaction-ID age at one billion. Query text, customer records, and credentials are never included in snapshots.
- ClickHouse: required analytics tables, failed or ten-minute stalled mutations, and detached parts needing review.
- NATS: commerce stream presence, file persistence, publishing configuration, leader/replica state, reported message loss, and configured storage/message limits at 90%. Existing consumer-progress checks remain active.
- MinIO: cluster readiness and an authenticated HEAD of `commerce-media` using the gateway's configured credentials. This verifies bucket access without writing objects; it does not prove a future upload will succeed.
- Meilisearch: authenticated metadata, the required products index, indexing failures in the last two minutes, and the oldest queued/processing task over ten minutes.
- Every checked data volume: persistent mount presence, read-only state, available space and inodes (90% threshold). Shared filesystem usage may appear on multiple volumes.

Infrastructure failures affect store badges, effective container health, and dashboard incidents; unavailable diagnostics show unknown. These probes do not perform write tests, integrity scans, or backup/restore verification. They do not restart services or change the architecture. Alerts remain dashboard-only.
