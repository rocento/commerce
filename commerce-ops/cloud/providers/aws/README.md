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

## Merchant onboarding AWS foundation (prepared, not deployed)

[`merchant-foundation/`](merchant-foundation/) is a separate Terraform root owned
by AWS operations and run from a trusted operator workstation. It prepares an
S3 state bucket, a dedicated merchant security group, and an EC2 launch template.
It does not create instances, attach IAM policies, install services, or enable
onboarding. The existing per-host Terraform root remains the VM owner; see the
[merchant fleet guide](../../../services/onboarding/README.md#merchant-fleet-aws-google-cloud-and-hetzner).

The required inputs are in
[`terraform.tfvars.example`](merchant-foundation/terraform.tfvars.example).
Copy it to ignored `.local/commerce-ops/` and fill in the account, existing VPC and
public subnet, stable controller IPv4 `/32`, reviewed Cloudflare proxy CIDRs,
globally unique bucket name, and a pinned **official Canonical Ubuntu 24.04 AMI**.
The foundation queries Canonical account `099720109477` (commercial AWS), requires
an available public Noble image, and checks architecture and disk compatibility.
The `t4g.xlarge` profile provides 4 vCPUs and 16 GiB for up to three clients; Terraform rejects other CPU/memory sizes,
incompatible architectures, private/unavailable images, inherited extra disks, and
root snapshots larger than the requested disk. Confirm the subnet route table has Internet Gateway access,
available addresses, compatible NACLs, instance-type availability, and quota
before applying. This root does not modify existing network infrastructure.

Security defaults:

- Private, versioned state with SSE-S3 encryption, bucket-owner enforcement,
  all four public-access blocks and a TLS-only bucket policy. No expiry rules
  delete recovery history. Bucket, security group and template have Terraform
  `prevent_destroy`; this is not protection against out-of-band administrators.
- SSH only from the controller IP; HTTPS only from the supplied reviewed proxy
  allowlist. Port 80 and database ports are closed. IPv6 is not configured.
  Refresh the allowlist from [Cloudflare's published ranges](https://www.cloudflare.com/ips/)
  before a real plan. Outbound IPv4 is allowed for package/registry pulls, DNS,
  SMTP and application dependencies; the host runtime blocks container access
  to instance metadata.
- Encrypted gp3 root disk, IMDSv2 with hop limit 1, termination protection,
  shutdown behavior `stop`, no IAM instance profile or EC2 key pair. Per-host
  cloud-init supplies the unique pinned SSH identity and forced command.
- Launch template versions are not automatically made default. Copy the explicit
  numeric version from the output into the fleet profile after review; existing
  host bindings remain pinned.

### Scoped controller permissions

[`provisioning-policy.tf`](merchant-foundation/provisioning-policy.tf) renders
`provisioning_policy_json`, binding permissions to the selected account/region,
AMI, template, instance type, subnet, security group and AWS state prefix.
It grants region-limited EC2 discovery, constrained `RunInstances`, creation-time
instance tagging, and attribute reads limited to tagged merchant hosts.
Termination protection is set in `RunInstances`; no permission to modify existing
instances is needed by the pinned provider in this creation-only workflow.
It grants state read/write and lock read/write/delete, but not state deletion.
No IAM administration, `PassRole`, instance termination, security-group edits,
launch-template edits, bucket administration, or KMS decrypt is granted. This
configuration deliberately uses SSE-S3 and default EBS encryption; a customer
managed EBS key requires separately reviewed KMS permissions before launch.

Use a dedicated provisioning identity or review all policies already attached
to the controller role before attaching the output. An allow policy is **not a
permissions boundary**: other policies can grant additional access. Instance-attribute
reads cover UUID-tagged merchant instances in this account/region, not a
particular host UUID. IAM wildcard tag patterns check the tag shape; canonical
UUID validation and identity matching remain controller responsibilities. Template version selection
and the maximum **three customers per host** remain enforced by the controller;
IAM cannot enforce those limits. `maxHosts=2` in the disabled output is a separate
initial fleet limit, not the customer-per-host limit or an AWS billing cap.
The controller must not have foundation/bootstrap credentials.

The policy follows AWS's [launch-template permission examples](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ExamplePolicies_EC2.html)
and HashiCorp's [S3 state/lock permissions](https://developer.hashicorp.com/terraform/language/backend/s3).
Mock tests validate configuration and policy structure; they do not prove real
AWS authorization. Before enabling provisioning, validate the rendered policy
with IAM Access Analyzer and IAM simulation, then an authorized EC2 `DryRun`
using the exact template version, tags and cloud-init overrides. Check negative
cases (other AMI/subnet/security group/type, missing tags, unencrypted disk,
IMDSv1, template bypass, termination and state deletion). `DryRun` cannot prove
capacity, boot success, full Terraform post-launch permissions or recovery.

### State bootstrap and later activation

The foundation initially uses a local backend because its S3 bucket does not yet
exist. **For a future authorized bootstrap**, initialize with an absolute backend
`path` under ignored `.local/commerce-ops/` and a restrictive `umask 077`; keep an
encrypted backup and allow one operator at a time. Do not run a real plan or
apply from this preparation task. Bootstrap credentials belong to the operator,
not the fleet role. Later, migrate foundation state with `terraform init
-migrate-state` after changing its backend to S3, using a separate key such as
`foundation/aws/terraform.tfstate`, `encrypt=true` and `use_lockfile=true`.
Verify migration and recovery before removing the protected local backup.
The controller's generated policy cannot read or write this foundation prefix.

After a separately approved foundation apply, export `terraform output -raw
provisioning_policy_json` for review and attachment, and `terraform output -json
fleet_config_fragment` for merging into the private fleet configuration. The
fragment intentionally retains `enabled=false`; preserve SSH and Cloudflare
settings when merging. All per-host state uses S3 native locking and distinct
`<keyPrefix>/aws/<hostUUID>.tfstate` keys. Use only Terraform's default workspace.

Remaining live gates are bucket-name availability, account/region and subnet
verification, image/release approval, rendered IAM validation, remote-state
read/write/lock contention and version recovery, and one explicitly approved
canary VM. The canary must verify complete Terraform create/read permissions,
boot, metadata isolation, SSH attestation, TLS, SMTP, application health, three
merchant reservations, fourth-merchant allocation to another host, restart
reconciliation and ambiguous-create recovery. Cleanup requires an operator;
the provisioning role intentionally cannot terminate instances.

### Offline verification

These commands download/use the pinned provider and run mocked plans only. They
do not use AWS credentials or initialize an S3 backend:

```sh
terraform -chdir=commerce-ops/cloud/providers/aws/merchant-foundation init -backend=false -input=false -lockfile=readonly
terraform -chdir=commerce-ops/cloud/providers/aws/merchant-foundation fmt -check
terraform -chdir=commerce-ops/cloud/providers/aws/merchant-foundation validate
terraform -chdir=commerce-ops/cloud/providers/aws/merchant-foundation test -json -verbose > /tmp/aws-foundation-tests.jsonl
AWS_FOUNDATION_PLAN_JSON=/tmp/aws-foundation-tests.jsonl python3 commerce-ops/tests/operations/test_aws_foundation_policy.py
```

CI runs the same checks in the onboarding workflow. Tests cover bucket safety,
network ingress, node defaults, policy action/resource boundaries, lock-only
deletion, disabled/pinned outputs, and rejected public ingress, missing AMI,
wildcard state scope, wrong VPC, insufficient RAM and mismatched architecture.

Review verification (2026-11-12): the pinned AWS provider's
[`aws_instance` create/read implementation](https://github.com/hashicorp/terraform-provider-aws/blob/v6.40.0/internal/service/ec2/ec2_instance.go)
was checked against the creation-only module. Existing-instance mutation
permissions were removed; `DescribeInstanceAttribute`, which can expose user
data, was separated from broad discovery and restricted to tagged merchant
resources using AWS's [resource-level authorization support](https://docs.aws.amazon.com/service-authorization/latest/reference/list_ec2.html).
The local policy evaluator intentionally supports only the emitted IAM operators;
it checks rendered-policy allow/deny cases, not AWS context-key availability or
other attached policies. Terraform mock plans cover 31 scenarios including ARM64
and x86, minimum memory and snapshot boundaries, malformed/wildcard inputs,
public/pending/incompatible AMIs, extra disks and excessive ingress rules. The
rendered policy has an output precondition enforcing IAM's managed-policy size
limit, including actual input lengths. Terraform's default-workspace backend may
log denied listing of `env:/`; version 1.14 tolerates that denial and uses the
default workspace, so no unrelated workspace listing permission is granted.

## Ubuntu base image and GitHub CI releases

Custom merchant AMI baking is replaced by the [pinned release procedure](../../../services/onboarding/README.md#prepare-ubuntu-and-pinned-ci-releases-before-enabling).
Select the exact regional Ubuntu 24.04 server image ID from Canonical and record it
in `merchant_ami_id`; do not select a moving image at each onboarding request.
See [Canonical image discovery](https://ubuntu.com/aws/docs/aws-how-to/instances/find-ubuntu-images/).
Terraform owns the launch template and VM. Cloud-init installs the runtime;
the controller downloads the reviewed private GitHub release by numeric asset ID
and SHA-256 and transfers it over pinned SSH. The existing release evidence,
metadata firewall, host identity, saved-plan and recovery checks remain mandatory.

Use a new numeric launch-template version and release profile for new hosts.
Existing hosts, old Terraform bindings, volumes and snapshots are not replaced or
deleted automatically. Keep old artifacts for recovery until explicit retirement.
The former `merchant-image-build.example.json` is historical evidence only and is
not an onboarding prerequisite. No builder or AMI creation is part of this flow.

Before enabling the fleet timer, qualify a disposable Ubuntu host through package
installation, private release transfer, architecture and image-ID checks, metadata
isolation, TLS/SMTP preparation, capacity checks and public merchant health checks.
A local test pass does not establish live provider acceptance. Preserve state and
bootstrap intent on failures; reconcile uncertain outcomes without replaying apply.
