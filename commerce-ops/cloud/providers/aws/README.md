# Deployment commands

Complete the [shared production prerequisites](../../../deploy/README.md#before-a-production-deployment)
before using these AWS launchers.

AI service documentation is maintained in [AI service documentation](../../../../commerce-docs/ai-service/README.md).

AWS launchers, public templates and operating guides live in
`commerce-ops/cloud/providers/aws/`. Deployment-host implementations
used by both provider launchers live in [`commerce-ops/cloud/host/`](../../host/README.md);
installed compatibility commands remain under `deploy/ec2/server/`.
Private targets live in `.local/commerce-ops/targets/`; keys, bootstrap, TLS,
contact, and mail settings live in `.local/commerce-ops/secrets/aws/`. These
paths are ignored by Git and source uploads. See the
[deployment map](../../../deploy/README.md) and
[repository command reference](../../../../commerce-docs/platform/reference/scripts.md).

Run the local commands below from the repository root. All AWS launchers read
the named target at `.local/commerce-ops/targets/production-aws.env` and use `/opt/rocento` on that host.
Confirm its `HOST` value before running a production command. The
managed Rocento demos are `grocery`, `jewelry`, `electronics`, and `pharmacy`;
`all` selects all four. Server commands are in a separate section below.

## Choose a deployment

| Change | Local command |
| --- | --- |
| Commerce/frontend updates while retaining the running production AI release | `bash commerce-ops/cloud/providers/aws/deploy.sh --preserve-ai` |
| Full application including AI and assistant configuration (default) | `bash commerce-ops/cloud/providers/aws/deploy.sh` |
| Full deployment with a verified versioned language bundle | `bash commerce-ops/cloud/providers/aws/deploy.sh --sync-language-data` |
| Full deployment with an explicitly selected local language database release | `bash commerce-ops/cloud/providers/aws/deploy.sh --sync-language-db --release-id RELEASE_UUID` |
| Python AI service only | `bash commerce-ops/cloud/providers/aws/deploy-ai.sh --service ai` |
| Language engine with a verified versioned release | `bash commerce-ops/cloud/providers/aws/deploy-ai.sh --service language --sync-language-data` |
| Both AI services with a verified versioned release | `bash commerce-ops/cloud/providers/aws/deploy-ai.sh --sync-language-data` |
| Demo catalog/data updates | `bash commerce-ops/cloud/providers/aws/seed-demo.sh --store all` |

Full deployment initializes missing or empty dedicated language databases from the packaged rules/vocabulary release before starting the assistant. Databases with existing application objects are left unchanged by this first-install step; existing releases still use explicit operator upgrades. Shared installations and `--preserve-ai` retain their existing lifecycle.

Full and AI deployments do not seed demo data. The fast AI commands require an existing full deployment and promote selected preverified assistant images without publishing frontend assets or restarting PostgreSQL.

Full deployment also prepares up to 100 existing public storefront images per store before frontend publication. This upgrades older image manifests to responsive WebP without replacing originals or reseeding catalog data. Processing failures stop frontend publication and report the affected IDs; remaining candidates can be processed in another bounded batch. See [media operations](../../../../commerce-docs/backend/publication.md#feed-and-media-operations).

## Local prerequisites

Full deployment uses these protected files:

| File | Purpose |
| --- | --- |
| `.local/commerce-ops/targets/production-aws.env` | Current EC2 host; copy from [target example](../../../config/examples/production-aws.env), set `PROVIDER=aws` and `HOST` |
| `.local/commerce-ops/secrets/aws/rocento.pem` | EC2 SSH private key; launcher sets mode `400` |
| `.local/commerce-ops/secrets/aws/bootstrap.env` | Configuration copied from [bootstrap.env.example](bootstrap.env.example); must have mode `600` |
| `.local/commerce-ops/secrets/aws/rocento-origin.pem` | Cloudflare Origin CA certificate |
| `.local/commerce-ops/secrets/aws/rocento-origin.key` | Matching private key |
| `.local/commerce-ops/secrets/aws/notifications.env` | Optional customer SMTP configuration; mode `600`; see [SMTP setup](SMTP.md) |
| `.local/commerce-ops/secrets/aws/contact.env` | Optional contact-form configuration; mode `600`; start with [contact.env.example](contact.env.example) |

Copy the target template once, then replace the example host with the
current EC2 public address or DNS name. Keep all secrets under
`.local/commerce-ops/secrets/aws/` with mode `600` (the SSH key uses `400`):

```bash
mkdir -p .local/commerce-ops/targets
cp commerce-ops/config/examples/production-aws.env .local/commerce-ops/targets/production-aws.env
chmod 600 .local/commerce-ops/targets/production-aws.env
```

Use `DOMAIN=rocento.com` in the bootstrap file. Keep the certificate and key mode `600`. SSH, rsync and Bash must be available locally; language packaging also needs the project's Node.js environment and installed language-engine dependencies. The full launcher uses macOS `stat` syntax and is intended to run from this Mac checkout. `ROCENTO_AWS_HOST` can override the file for one command; the loader validates the address before SSH.

Fast AI deployments and standalone seeding use the SSH key and reuse configuration already on EC2. They do not upload new TLS or SMTP settings. Use full deployment when those settings change. See [EC2 provisioning](../../../deploy/ec2/README.md) for initial server requirements.

## Full deployment

```bash
# Keep verified production AI running; deploy commerce and frontend changes.
bash commerce-ops/cloud/providers/aws/deploy.sh --preserve-ai

# Deploy all components, including a reviewed, runtime-matching AI release (default).
bash commerce-ops/cloud/providers/aws/deploy.sh

# Verify the existing versioned language bundle, then deploy all stores.
bash commerce-ops/cloud/providers/aws/deploy.sh --sync-language-data

# Export an explicitly selected immutable PostgreSQL release, then deploy all stores.
bash commerce-ops/cloud/providers/aws/deploy.sh --sync-language-db --release-id RELEASE_UUID

# Preview changed source and migration files without writing to EC2 or starting deployment.
bash commerce-ops/cloud/providers/aws/deploy.sh --dry-run

bash commerce-ops/cloud/providers/aws/deploy.sh --help
```

`--preserve-ai` requires an existing, healthy four-store deployment. It excludes local AI source, language bundles, assistant configuration and AI Compose overlays from upload and activation. It records running AI container/image/release identities, updates only explicit commerce services with `--no-deps`, and verifies those identities and readiness before frontend publication. AI services are not rebuilt/recreated, and AI database migrations or release promotions are not run. Gateway contract compatibility is checked using the existing Python image by immutable ID. Existing model definitions must match; additive response models are allowed. Features that require the newer AI implementation remain unavailable. Unreviewed local AI changes remain available locally but are not deployed. Explicit `--preserve-ai` cannot be combined with `--include-ai`, language export options or server `--restart`.

AI is included by default; `--include-ai` is an explicit alias for that behavior. Use `--preserve-ai` only to opt out. Either language sync option also selects AI deployment. Choose only one language sync option. Keep `compiled.json` and `deployment-release.json.gz` together from the same verified release; the bundle must also match the Node runtime hash. The launcher prints the selected release UUID and runtime hash before uploading. Verifying an obsolete bundle does not upgrade it, and changing its identity without reproducing the verified release is not a repair. Full deployment `--sync-language-db` requires `--release-id UUID`; export does not activate that release. Full deployment has no local `--store` or `--service` option. `--skip-seed` is accepted only for compatibility and has no effect. The old `--seed-demo` and `--seed-electronics` options are rejected; use `seed-demo.sh` instead.

The native `commerce-mobile-apps/` application tree and `commerce-docs/mobile/` documentation are explicitly excluded from upload and activation. Backend mobile API code and schemas remain part of the backend build.

The uploader writes to a private per-job staging directory. A detached server job acquires the existing deployment/seed lock before it mirrors managed source into `/opt/rocento`, backs up and mirrors migrations, or installs configuration. The lock remains held through deployment. Generated EC2 configuration, deployment secrets, rengine credentials/data, and persistent volumes are preserved. The server validates and promotes the exact reviewed images and frontend export; it does not build production artifacts. It starts services, publishes frontend assets, and checks public routes. Build and qualify artifacts before promotion. Its automatic cleanup removes disposable caches and old managed frontend releases; see [cleanup behavior](../../../tasks/rocento-platform-deployment.md#upload-activation-and-cleanup).

By default, the command updates the gateway, frontend, language runtime and Python assistant together. AI persistence upgrades follow the installation's configured topology; consolidated installations use [shared AI database operations](../../../../commerce-docs/ai-service/shared-database-operations.md). Readiness checks require the matching language release and storage privileges before deployment succeeds. Language candidates must be prepared and explicitly promoted using [the release runbook](../../../../commerce-docs/ai-service/language-release-upgrade.md).

Existing administrators with wildcard access can open `/assistant-tracking`.
For other intended operators, select `assistant.tracking.read` and, separately,
`assistant.tracking.export` under **Analytics & reports → Assistant tracking** in
the role editor. Deployment does not grant these permissions automatically.
Reviewed RAG example files are packaged, but their publication into a retrieval
collection still requires the existing reviewed knowledge import. Deployment
does not call the LLM, run a live canary or publish new embeddings automatically.
Use the full `deploy.sh` for this combined release; `deploy-ai.sh` alone omits the
gateway, frontend and proxy updates.

Full deployments run as a detached systemd job on EC2. The local launcher requires Python 3, streams the saved deployment log and reports the actual deployment exit code. An SSH disconnect triggers status reconnection without launching the deployment again. If reconnection fails three times, the job continues on EC2 and the launcher prints a command to resume monitoring the same job. Use that command before starting another deployment. Each job saves its status runner, log and exit code under `/var/log/rocento/deployments/jobs/<job-id>/`. Completed successful jobs remove their staging directory; failed uploads/jobs retain `/home/ubuntu/.rocento-deploy/<job-id>/` for diagnosis. After confirming the job has stopped, an operator can remove that exact failed staging directory. A busy deployment lock rejects activation before source or configuration changes; rerun the local launcher after the other job finishes.

Uploads scan only `commerce-api/`, `commerce-web/` (including `apps/rengine/` and `apps/health/`), `commerce-assistant-platform/`, the managed subdirectories of `commerce-ops/deploy/` and `commerce-ops/services/`, `commerce-ops/cloud/lib/source-filters.sh`, `commerce-ops/scripts/`, `commerce-ops/workflows/`, and Compose YAML files under `commerce-ops/compose/`. Frontend public images/fonts and application source remain included. Demo assets/presets, repository documentation, local workspaces, build outputs, and AI evaluation evidence are excluded. The Language Engine data upload contains only `compiled.json` and `deployment-release.json.gz`, matching the fast AI launcher. Seed assets use `seed-demo.sh` separately. If a future deployment adds a dependency outside these paths, update `configure_source_filters` in `commerce-ops/cloud/lib/source-filters.sh`, shared by the uploader and server activation. Managed deployment assets remain under `deploy/ec2`; assistant, contact, health-dashboard, observability, and rengine assets are canonical under `commerce-ops/services/`. Old service paths under `deploy/` are excluded; generated EC2 YAML and runtime state remain protected.

Rsync uses `--copy-dest` to copy unchanged server files into the isolated stage without transferring their payload again or sharing mutable hard links. Partial transfers are retained for retries within the same invocation. If comparison files are unreadable (rsync exit 23), staging retries once without `--copy-dest`; persistent transfer errors still stop before activation. Upstream rsync compresses changed payloads; Apple's bundled OpenRSYNC uses uncompressed transfers for compatibility with EC2's rsync. Both source and migration transfers print file/byte statistics; the launcher reports upload and total deployment time. Protocol/network interruptions (including exit 12) and transfers with no I/O for 120 seconds are retried within the three-attempt limit. Each retry closes this launcher's shared SSH session and reconnects. Activation removes deleted source files only within the managed source boundary, using the same exclusions to protect runtime files. Activation applies the exact migration-source mirror under the lock. Failures stop deployment and report the error; applied source, configuration, and artifact changes remain in place.

If deployment stops during `source-upload` or `migration-source-upload`, activation has not started and the active checkout remains unchanged. Rerun the same command to create a fresh isolated stage; in-process retries resume the current transfer. Repeated failures still stop before activation and retain the original transfer exit code; inspect the preceding rsync/SSH errors if they continue.

`--dry-run` requires an existing EC2 checkout. Default `--dry-run` validates the current packaged language release; `--preserve-ai --dry-run` excludes AI inputs and does not validate the unused local bundle. It previews source updates, removed managed source files, and migration removals, then exits without uploading configuration or starting the deployment. Protected configuration contents are omitted. It cannot be combined with language export options, because language export has its own preparation path.

## Fast AI deployment

```bash
# Default: both AI services, all stores, using the existing packaged release.
bash commerce-ops/cloud/providers/aws/deploy-ai.sh

# Python assistant only.
bash commerce-ops/cloud/providers/aws/deploy-ai.sh --service ai

# Language service and database release only.
bash commerce-ops/cloud/providers/aws/deploy-ai.sh --service language --sync-language-data

# Both services with the verified language bundle.
bash commerce-ops/cloud/providers/aws/deploy-ai.sh --sync-language-data

# Use the active local language database as the release source.
bash commerce-ops/cloud/providers/aws/deploy-ai.sh --service language --sync-language-db

# Target Python for one store; accepted stores also include jewelry, electronics and pharmacy.
bash commerce-ops/cloud/providers/aws/deploy-ai.sh --service ai --store grocery

bash commerce-ops/cloud/providers/aws/deploy-ai.sh --help
```

| Option | Accepted values / behavior |
| --- | --- |
| `--service` | `all` (default), `ai`, `language` |
| `--store` | `all` (default), `grocery`, `jewelry`, `electronics`, `pharmacy` |
| `--sync-language-data` | Verify an existing version 2 database-produced bundle |
| `--sync-language-db` | Export the active local PostgreSQL language release |
| `-h`, `--help` | Show usage without deploying |

Language sync options cannot be combined with each other or with `--service ai`. A language deployment requires a packaged release even when no sync option is supplied.

The command uploads only the selected runtime files, takes the existing deployment lock, verifies and promotes the selected prequalified images, and waits for health. It does not build images in production. Language startup verifies the migrated database, explicitly promoted release and matching packaged artifact. Shared language upgrades require `--store all`. It does not copy customer sessions, feedback, or evaluation records. When both services are selected, language health must pass before AI service startup.

Use full deployment for gateway/frontend contract changes, infrastructure, Compose changes, proxy configuration, or initial provisioning. AI preflight checks compatibility against the gateway contract already uploaded to EC2. A partial deployment does not mark the entire backend release as deployed.

## Prepare language releases

Follow [the language release runbook](../../../../commerce-docs/ai-service/language-release-upgrade.md) to create an immutable candidate, evaluate it, explicitly promote it and export its exact identity. Operator credentials are separate from runtime credentials.

`--sync-language-data` calls `export-release.ts`, which verifies an existing version 2 database-produced bundle and leaves it unchanged. Loose generated files cannot establish release provenance. `--sync-language-db` exports the active local database release. Both paths must yield a compiled artifact and bundle matching the target's explicitly selected release; upload or restart does not activate it.

## Demo seeding and delivery coverage

```bash
# All stores, or one selected store.
bash commerce-ops/cloud/providers/aws/seed-demo.sh --store all
bash commerce-ops/cloud/providers/aws/seed-demo.sh --store grocery
bash commerce-ops/cloud/providers/aws/seed-demo.sh --store jewelry
bash commerce-ops/cloud/providers/aws/seed-demo.sh --store electronics
bash commerce-ops/cloud/providers/aws/seed-demo.sh --store pharmacy

# Delivery areas, sources, stock pools and inventory for existing demo products.
bash commerce-ops/cloud/providers/aws/seed-demo.sh --store grocery --delivery-only

# Add missing Egypt demo zones alongside existing custom areas.
bash commerce-ops/cloud/providers/aws/seed-demo.sh --store grocery --delivery-only --expand-coverage

bash commerce-ops/cloud/providers/aws/seed-demo.sh --help
```

The default store is `all`. `--expand-coverage` requires `--delivery-only`. Seeding uses the existing deployed stack and uploads seeding helpers/assets without rebuilding or restarting services. It writes demo data: Grocery catalog seeding also deactivates the previous demo SKUs after creating their replacements. Use it for the four managed Rocento demos. See [seed behavior](../../../tasks/demo-seeding.md#seed-behavior-and-retained-data) for theme and administrator handling.

## Commands on the production server

Connect from your Mac using the same target file as the launchers:

```bash
bash -c 'source commerce-ops/cloud/providers/aws/target.sh; load_aws_target; exec ssh -i .local/commerce-ops/secrets/aws/rocento.pem "ubuntu@$AWS_HOST"'
```

Run the following **on EC2**. These commands use source already uploaded to the server:

```bash
cd /opt/rocento

# Full deployment modes.
sudo bash commerce-ops/deploy/ec2/server/ec2-up.sh
sudo bash commerce-ops/deploy/ec2/server/ec2-up.sh --verify-only
sudo bash commerce-ops/deploy/ec2/server/ec2-up.sh --no-build
sudo bash commerce-ops/deploy/ec2/server/ec2-up.sh --restart
sudo bash commerce-ops/deploy/ec2/server/ec2-up.sh --help

# Selected AI services, after their source has been uploaded.
sudo bash commerce-ops/deploy/ec2/server/ec2-deploy-ai.sh --service all --store all
sudo bash commerce-ops/deploy/ec2/server/ec2-deploy-ai.sh --service ai --store grocery
sudo bash commerce-ops/deploy/ec2/server/ec2-deploy-ai.sh --service language --store grocery

# Existing deployment status and diagnostics.
sudo bash commerce-ops/deploy/ec2/server/ec2-status.sh
sudo bash commerce-ops/deploy/ec2/server/ec2-doctor.sh
sudo bash commerce-ops/deploy/ec2/server/ec2-compose.sh grocery ps
sudo bash commerce-ops/deploy/ec2/server/ec2-compose.sh grocery logs --tail=100 ai-service commerce-language-engine
sudo bash commerce-ops/deploy/ec2/server/ec2-compose.sh grocery logs --tail=100 api-gateway
```

`--verify-only` checks the deployment without changing it. `--no-build` is accepted for compatibility; production deployments always require reviewed, preverified artifacts. `--rebuild` is rejected. `--restart` restarts service containers after reconciliation. Normal deployments leave unchanged gateways running; the explicit gateway/worker stop is used only when the engagement database still needs its initial historical-data import. Failure to read that import status aborts before stopping the gateway. These options belong to the server script, not the local `commerce-ops/cloud/providers/aws/deploy.sh` launcher.

Replace `grocery` with another store for its status/logs. Deployment logs are under `/var/log/rocento/deployments/`; fast AI logs are named `ai-*.log`. Seeding logs are under `/var/log/rocento/seeds/`. On a failure, inspect the printed stage and service logs before retrying. Successful changes to earlier stores remain applied.

## Deployment target

Use the configured current installation and the server commands above. The former Quality target is retired; its old Markdown instructions were removed. [Merchant publication](../../../../commerce-docs/backend/publication.md) describes current release checks.

## Supporting files

- [Deployment diagnostics](../../../tasks/diagnostics.md): transfer failures and migration history checks.
- [SMTP.md](SMTP.md): customer email configuration, installed through full deployment.
- [`../../host/cleanup.py`](../../host/cleanup.py): invoked automatically by full host deployment; not a separate local deployment command. The legacy server path forwards here.
- [EC2 reference](../../../deploy/ec2/README.md): provisioning, server modes and recovery guidance.

## rengine diagnostics service

Deploy the separate all-demo lab with `bash commerce-ops/cloud/providers/aws/deploy-rengine.sh`. It owns `rengine.rocento.com` and its own Compose/Nginx configuration. See [rengine operations](../../../../commerce-docs/rengine/README.md) for access, test scope and verification.

## Contact delivery and first electronics setup

Company contact form: copy commerce-ops/cloud/providers/aws/contact.env.example to .local/commerce-ops/secrets/aws/contact.env,
set CONTACT_SMTP_PASSWORD to the info@rocento.com mailbox password and chmod 600
the file. The launcher securely installs it outside the web root. The form at
/about/#contact sends Sales, Support, Demo request and Partnership enquiries to
info@rocento.com, with the visitor as Reply-To. SMTP credentials never reach the
browser. Namecheap Private Email uses mail.privateemail.com with verified TLS
on port 465. The endpoint limits submissions to 30 per hour across the site.
Without credentials it returns an unavailable error and offers direct email.
After deployment, submit a test enquiry and confirm it arrives in the mailbox;
SMTP acceptance alone does not prove inbox placement.

First electronics release: add Cloudflare `electronics` and `electronics-admin` records pointing at the existing EC2 server and set `ELECTRONICS_ADMIN_EMAIL` / `ELECTRONICS_ADMIN_PASSWORD` in the protected `.local/commerce-ops/secrets/aws/bootstrap.env`. Run `bash commerce-ops/cloud/providers/aws/deploy.sh`, then separately on EC2 run `sudo bash /opt/rocento/deploy/ec2/server/ec2-seed-demo.sh --store electronics`.
