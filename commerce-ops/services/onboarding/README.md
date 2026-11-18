# Onboarding AWS test deployment

This separate test stack runs the customer onboarding UI, Rust API, provisioning worker and a dedicated
PostgreSQL database on a Linux host. It does not deploy the corporate site, demo
stores. Merchant provisioning uses the separately installed host worker and fleet
controller described below. Application source remains in
`commerce-web/apps/onboarding/` and `commerce-api/ops-api/`.

## Layout and configuration

The test instance uses `/home/ubuntu/commerce-ai` for the uploaded source and
`/opt/rocento-onboarding/config` for root-only runtime inputs. The Compose project
is `rocento-onboarding-test`; its named database volume survives container restarts.
Source uploads include tracked and non-ignored new files, excluding credentials,
workstation state and generated dependencies. They do not contain Git history.

Required files in the protected configuration directory:

- `postgres.env`: `POSTGRES_USER=onboarding`, `POSTGRES_DB=onboarding`, and a random
  `POSTGRES_PASSWORD`.
- `api.env`: the matching database URL on `127.0.0.1:5439`, `APP_ENV=staging`,
  `AUTH_MAIL_MODE=smtp`, random `AUTH_MAIL_KEY`, `LOCAL_AUTH_ENABLED=false`,
  `CUSTOMER_ORIGIN=https://onboarding.rocento.com`, SMTP settings and test billing.
  See the [API configuration](../../../commerce-api/ops-api/README.md).
- `worker.env`: only the same `DATABASE_URL` as the API; no SMTP or operator token.
- `origin.pem` and `origin.key`: certificate and private key covering
  `onboarding.rocento.com`; keep the directory mode 700 and files mode 600.

API and UI use Linux host networking and bind only to loopback ports 4100 and
3100. PostgreSQL publishes only loopback port 5439. Nginx is the public entry point.
No public operator API route is forwarded by the UI.

## Build and start

Run on the deployment host with Docker, Compose v2 and Nginx installed:

```sh
cd /home/ubuntu/commerce-ai
sudo docker compose -f commerce-ops/services/onboarding/compose.yaml build
sudo docker compose -f commerce-ops/services/onboarding/compose.yaml up -d --wait postgres
sudo docker compose -f commerce-ops/services/onboarding/compose.yaml run --rm --no-deps api migrate
sudo docker compose -f commerce-ops/services/onboarding/compose.yaml up -d api web
# Install the host worker after its executor review:
sudo bash commerce-ops/services/onboarding/install-merchant-worker.sh
sudo install -m 644 commerce-ops/services/onboarding/nginx.conf /etc/nginx/sites-available/onboarding
sudo ln -sfn /etc/nginx/sites-available/onboarding /etc/nginx/sites-enabled/onboarding
sudo nginx -t && sudo systemctl reload nginx
```

Use `docker compose ... ps` and `logs --tail 50 api provisioning-worker web` for diagnostics. Do not
run `down -v` against a database containing test evidence you need to preserve.
To stop this stack, use `stop`; this does not remove its database volume.

## Cloudflare and AWS ingress

Create a proxied A record named `onboarding` pointing to the instance's public
IPv4 address (prefer an Elastic IP), TTL Auto. Enable HTTPS redirection for this
hostname and Full (strict) TLS after installing its valid origin certificate.
Do not change unrelated DNS records. Bypass cache for this hostname if the zone
has broad cache-everything rules; account and API responses must not be cached.

Allow HTTPS 443 from Cloudflare's published IP ranges in the EC2 security group;
allow HTTP 80 if using the origin redirect. Keep SSH restricted to operator IPs.
Do not expose ports 3100, 4100 or 5439. A Cloudflare Origin CA certificate is
trusted by Cloudflare, not ordinary browsers connecting directly to the IP.

References: [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/),
[Origin CA](https://developers.cloudflare.com/ssl/origin-configuration/origin-ca/),
[Cloudflare IP ranges](https://www.cloudflare.com/ips/).

## Acceptance and limits

Check the HTTPS page, registration/login, delivered verification email, draft
save/reload, paired hostname reservation, payment request and operator
confirmation. The customer cannot confirm their own payment. Operator commands
and duplicate/expiry handling are documented in the API guide.

This installation uses synthetic billing terms: EGP 1.00 and 30 service days for
each plan, with explicit instructions never to send money. These are not approved
commercial prices. Confirmation creates `QUEUED`; the durable worker picks up the payment and
reports missing release prerequisites. The job orchestration, activation transaction and host executor are implemented.
The executor still requires candidate runtime verification and reviewed release
evidence before merchant activation. Wildcard DNS is configured on the test zone. See the
[worker contract](../../../commerce-api/ops-api/README.md#durable-provisioning-jobs).
Back up PostgreSQL before migration 005; preserve the old image tags for rollback.
Do not roll back the database by dropping tables or removing its volume. The staff app runs as the `ops` Compose service, with its exact hostname configured by `ops-nginx.conf`. SMTP transport configuration alone does not prove
inbox delivery; verify it using a real tester's mailbox before acceptance.

## Automatic merchant provisioning

### Checkpoint execution and coordinated rollout

Migration 011 records DATABASE, MIGRATE, SERVICES, BOOTSTRAP and INGRESS separately.
A node runs one checkpoint per request with a cumulative 100-second deadline;
individual commands share the remaining budget and timed-out command process groups
are killed/reaped. The controller allows up to 110 seconds for SSH, the worker
130 seconds for execution and 20 seconds for read-only receipt reconciliation,
within the existing 180-second lease. Docker operations can outlive their CLI;
an interrupted intent remains review-required even after process cancellation.

Root-owned node receipts live under
`/opt/rocento-merchants/execution-receipts/<job UUID>/<step>.json`. Intent is synced
before mutation and completion is synced before responding. Receipts bind job,
tenant, payment, step, release, environment and hostnames. A completed receipt can
return evidence under a currently authorized lease without repeating the step.
A missing receipt during reconciliation, incomplete intent or identity mismatch
never authorizes replay. Preserve receipt directories and any `.tmp` files when
investigating failures; never delete them to force retry. Expired database leases
still require operator review. Qualification's `start_runtime` helper retains its
full startup sequence; provisioning uses separate calls.

The worker defaults to four concurrent jobs (`PROVISIONING_CONCURRENCY=1..8`).
Remote dispatch uses a controller lock per host at `fleet/<host UUID>/execution.lock`;
each node retains its existing `deployment.lock`, protecting ports, nginx and
suspension together. Local legacy execution retains the original deployment lock.
A busy host does not consume failure retries. A restriction blocked by active
node execution remains PENDING for the next controls run.

Fleet reconciliation prepares up to four different hosts concurrently per timer
run. Root `fleet.json` can set `reconcileConcurrency` to 1–8. The existing controller
`fleet.lock` still excludes overlapping batches, and each host retains its private
Terraform state, locks, creation intent and authorization checks. Host budgets and
three-slot placement constraints are unchanged.

Rollout is a coordinated protocol change, not a rolling mixed-version upgrade:

1. Prepare and qualify matching worker, controller and node artifacts, including
   fresh executor/tool hashes and release evidence. Existing hosts need an explicit
   reviewed release transition; never rewrite approved hashes to bypass identity checks.
2. Stop/drain workers and the fleet timer. Inspect RUNNING jobs and reconcile any
   expired/ambiguous execution; migration 011 refuses to run while any job is RUNNING.
3. Apply migration 011 and install the matching protocol-v2 components and systemd
   worker unit (`TimeoutStopSec=170`). Preserve state, secrets, locks and receipts.
4. Begin with concurrency 1, verify a canary through every checkpoint, public HTTPS
   identity and service coverage, then raise concurrency after independent-host and
   same-host contention checks. Restart the fleet timer with its reviewed configuration.

Migration preserves completed legacy DEPLOY evidence and maps unfinished DEPLOY
jobs to DATABASE without clearing failures. Old protocol requests are rejected.
New provisioning binaries must accompany the forward schema change; an old worker
cannot safely consume the new checkpoint names. No automatic migration of existing
merchant releases or production rollout is performed by this source change.


Merchant runtimes use production mode only. Before starting the gateway, the
executor starts PostgreSQL, runs `install-catalog-data --install-core --industry
<selected-demo> --apply` using the pinned API image, and reads the database-generated
publication installation UUID. It persists that binding in the tenant's protected
`publication.env`; a changed database identity fails rather than rebinding silently.
The gateway receives its exact approved storefront origin and a read-only mount
of the reviewed storefront `index.html`. Missing artifacts or publication inputs
fail closed. The disposable candidate verifier uses this same startup sequence.
Search indexing remains disabled by the publication override and Nginx headers;
this is a publication restriction, not a separate runtime environment. Enabling
indexing requires the existing publication-policy and public-ingress acceptance.
These executor/verifier changes require a new candidate and fresh release evidence.
The executor's pure Compose/Nginx helper, `merchant_templates.py`, is installed
beside it and pinned separately in candidate tools and node identity. Both
installers and the merchant bundle include that dependency. Inventories created
before this extraction must be rebuilt and requalified; do not edit an approved
inventory to add its hash. The controller implementation now lives under
[cloud/controller](../../cloud/controller/README.md), while node execution and
bootstrap remain under [cloud/host](../../cloud/host/README.md). Installed command
names and protected state paths have not changed.

One proxied Cloudflare A record, `*` → the instance public IP, covers new
`<slug>.rocento.com` and `<slug>-admin.rocento.com` names. Keep existing explicit
records unchanged; they take precedence over the wildcard. Full (strict) TLS and
the existing wildcard origin certificate cover both names. See
[Cloudflare wildcard behavior](https://developers.cloudflare.com/dns/manage-dns-records/reference/wildcard-dns-records/).
The legacy single-host installation needs no per-client DNS token. The fleet below
creates exact per-merchant records pointing at each assigned host.
`merchant-default.conf` rejects unknown HTTPS hosts until exact tenant routes exist.

After staff select hosting and an operator confirms payment, the worker allocates an available
loopback API port, generates distinct credentials, starts ten tenant-specific
containers on their own network/volumes, migrates the database, installs the selected
Grocery, Jewelry, Electronics or Pharmacy catalog definitions, bootstraps the initial
administrator and publishes that demo’s theme. It never seeds demo products or overwrites an existing administrator/theme.
The paired Nginx sites serve the immutable storefront/admin artifacts. Final checks
verify public HTTPS, tenant/release identity, runtime health and container isolation.
Only the control-plane transaction may then mark the tenant ACTIVE and start coverage.

The host worker runs as `rocento-provisioner`; it has no Docker group membership.
Its sole sudo command is the root-owned executor with no command-line arguments.
The executor rechecks the RUNNING lease, confirmed payment, verified account and
approved theme in PostgreSQL. Customer job fields cannot select filesystem paths,
commands, images or an arbitrary hostname. A global lock protects host allocation. The new fleet caps each host at three
merchant reservations and uses 4-vCPU, 16-GiB instances for up to three clients.
This is the configured fleet size, not a load-test guarantee. The node checks
for four CPUs and nominal 16 GiB RAM (allowing 1 GiB for system-reserved memory).
The per-merchant container ceilings total 6.625 GiB, so three merchants can
collectively exceed host RAM at their ceilings. The existing 6-GiB available-memory
admission check remains and can block placement execution under memory pressure;
three slots do not guarantee peak-load capacity. The
existing test host is not automatically enrolled. Failed
allocations retain their slot until an operator reconciles their resources.
Idle memory alone is not treated as reserved capacity.
Runtime state and bootstrap credentials are root-only under
`/opt/rocento-merchants/<tenant-uuid>/`; credential delivery to the merchant remains
an operator handoff, not an implemented invitation/SSO flow.

The installation script copies the existing SMTP settings on-host to root-only
`/etc/rocento/merchant-provisioning/smtp.json`, installs the fixed executor and
release validator, and replaces the container worker with a systemd worker. The
container worker is retained under the explicit `container-worker` Compose profile
for development-only orchestration. Do not run both worker deployment modes.
Use `systemctl status rocento-merchant-worker` and its journal for diagnostics.
The installer neither approves a theme nor changes the existing confirmed payment.

## Four-demo release bundles

New candidates use inventory schema 2 and include Grocery, Jewelry, Electronics
and Pharmacy in one immutable release. Each theme is inventoried under
`artifacts/themes/<theme>.json`, and the source manifest hashes all four originals.
All four control-plane theme rows can reference the same reviewed version and
inventory digest, allowing the fleet's existing pinned release to serve any of
these store types. No migration automatically approves those rows.

The executor binds the job's selected theme to the release inventory, installs
that industry's catalog package, and publishes that theme only. The verifier runs
each bundled theme in a fresh disposable tenant and cleans it up before the next.
Legacy schema-1 single-theme inventories remain readable; changing executor bytes
still requires a new release and review, never rewriting an old approved hash.

Deploying the staff UI/API exposes Job status, Step and Details directly in Store
details, including paid stores awaiting worker ingestion. That UI deployment does
not activate a new merchant release. Build and qualify the bundle, retain release
approval evidence, update the controller/node release pins through the existing
reviewed rollout, and approve the four exact theme/version/digest bindings before
resuming provisioning. Demo merchandise remains a separate explicit import.

## Grocery candidate and approval

The 2026-11-12 local rebuild is **not security-approved**. The retained MinIO
community source has upstream authentication-bypass findings
[CVE-2026-40344](https://github.com/minio/minio/security/advisories/GHSA-9c4q-hq6p-c237)
and [CVE-2026-41145](https://github.com/minio/minio/security/advisories/GHSA-hv4r-mvr4-25vw).
Updating Go and Debian packages does not fix these server paths. Obtain a
supported patched storage artifact or implement and independently review a
mitigation before promotion; internal networking and a successful S3 smoke test
alone do not resolve the findings. See the dated
[verification history](../../../commerce-api/ops-api/docs/verification.md) for
the exact candidate, scan scope and remaining acceptance work.

Build `commerce-web/Dockerfile.merchant-release` from the frontend context and the
commerce API Dockerfile from `commerce-api/rocento-api`. The reusable admin bundle
pairs its hostname with the matching storefront, without embedding one tenant's URL.
The expected prebuilt MinIO image was unavailable from both configured registries;
`Dockerfile.minio` builds the explicit official source release instead. This changed
dependency requires its own compatibility/security evidence before approval.

The 2026-11-17 dependency remediation adds `minio/dependency-security.patch`
after the network patch, preserving exact Go module checksums and the existing
protocol mitigations. The statically linked binary runs in a scratch image with
CA certificates; no Debian package tools or shell are needed by the service.
Local dependency/image scans and signed S3 regression checks are retained in
`commerce-output/2026-11-17-security-remediation/`. They do not replace independent
review of the retained MinIO source mitigations or qualify a new merchant release.

Before building, capture the selected source inputs, including uncommitted changes:

```sh
python3 commerce-ops/services/onboarding/prepare-merchant-candidate.py \
  --source "$PWD" --write-source-manifest /private/tmp/grocery-source.json
```

Use an available private temporary path on Linux. The command prints separate
`api`, `web` and `minio` component fingerprints. Pass the corresponding value as
`--label io.rocento.source.sha256=<component-sha256>` to each Docker build. Keep
the source unchanged while building; include the source manifest with the source
upload. The hash inventory excludes secrets and generated dependencies using the
same exclusions as the API and merchant frontend Docker ignore files. It records
file hashes, not source contents. Build labels are provenance metadata, not
signatures or independent proof of a trustworthy build.

For a local review draft, append `--source "$PWD" --output-directory /path/to/new-draft`
to the preparation command below. This mode requires no root access, uses the
matching source executor/policy bytes, and writes only the new draft directory.
It still checks source and image provenance and creates a pending readiness packet.
It neither installs host authorization nor updates the control plane. The eventual
host candidate has the same identity only if image IDs, artifacts and installed
tool bytes match; any difference requires a new candidate and evidence.

`prepare-merchant-candidate.py --source-manifest /path/to/grocery-source.json`
runs as root on the test host after image preparation. It rejects source drift,
missing/mismatched image labels, installed executor/policy drift and artifact
symlinks. It extracts the frontend using its immutable image ID, pins all runtime
image IDs, records source revision/fingerprints, migration hashes, image repository
digests when available, and the executor configuration/template fingerprint without
private credentials. It creates a candidate directory
under `/etc/rocento/merchant-provisioning/releases/<inventory-sha256>/`. The readiness
packet is intentionally pending and unapproved. Artifact directories are traversable
by Nginx; SMTP and runtime credentials remain private. Preparing a packet grants no
release authorization and never updates `storefront_themes`.

To qualify a new MinIO image while retaining existing image tags, pass
`--minio-image-id sha256:<exact-image-id>`. This accepts only an immutable local
image ID, verifies its returned identity and source label, and leaves every
other image reference unchanged. A different MinIO image or source set creates
a new candidate; earlier approval and evidence do not authorize it.

For a Docker engine that assigns different immutable IDs to imported images,
pass `--image-ids /path/to/target-image-ids.json` instead. The JSON object must
contain exactly `api`, `postgres`, `nats`, `meili`, `minio`, `clickhouse`, and
`web`, each mapped to its verified `sha256:<64 lowercase hex>` ID on that engine.
The preparer checks every returned ID, platform and source label as usual without
changing tags. Preserve separate import evidence linking original image config
and layer hashes to the target IDs. This produces a new target-specific candidate
with pending evidence; image content equivalence does not grant release approval
or replace verification on the target host.

The executor invokes the existing
[release-readiness policy](../../../commerce-docs/platform/operations/release-readiness.md).
Candidate preparation accepts `--environment aws-merchant-production` (the default)
and `--release-version <version>` to bind the inventory and pending packet to the
intended production installation. Set the exact same environment in the fleet
profile; a packet for another installation cannot authorize it. Always supply a
new release version for a new production candidate.
All nine evidence categories and an independent review are required for that exact
candidate and environment. Review is per release, not a manual DNS/server setup for
every client. Do not mark pending evidence passed merely because unit tests or builds
succeeded. Only after the packet passes should an operator register the matching
Grocery version/digest as APPROVED. Missing or expired review returns a blocked job;
ambiguous runtime failures require reconciliation instead of blind retries.

### Disposable runtime verification

On the test host, after installing the executor and preparing all candidate images:

```sh
sudo python3 /usr/local/lib/rocento/verify-merchant-candidate.py \
  --disposable --candidate-sha256 <inventory-sha256>
```

The worker installer installs the verifier root-owned. Verification rejects altered
inventory, tool/verifier checksums, artifact hashes or image identities before
starting resources, and repeats those checks afterward. It uses the candidate's
exact image IDs and theme rather than current tags or working-tree theme bytes.
Each run gets a unique separate fixture project and private directory, loopback
port 18999, throwaway data, and non-delivering SMTP settings. It checks fresh
migrations, Grocery installation, admin authentication, theme publishing, repeat
bootstrap and runtime isolation, then removes only that fixture's containers and
volumes. A busy fixture port fails rather than attaching to an existing runtime.
Sanitized `runtime-evidence.json` records the candidate, images, timestamps,
cleanup outcome and coverage limits. Private runtime logs remain under
`/opt/rocento-onboarding/candidate-verification/`; do not publish raw logs or credentials.
This is not a public ingress, customer journey, external email, upgrade, security
or capacity acceptance test, and does not grant release approval.

### Operator alerts

`provisioning-alerts.py` reads a root-only `alerts.json` containing `recipient`
and the protected SMTP configuration. Its systemd timer checks every minute for
terminal FAILED jobs and an unavailable worker service. Each failure is sent once;
an ambiguous SMTP attempt stays in-flight for operator reconciliation instead of
being resent automatically. It does not send customer invitations or report
expected release-approval blockers as failures. Database/host outages still need
an external monitor; this local timer is not complete operational acceptance.

Install the script root-owned under `/usr/local/lib/rocento/`, and install the
matching service/timer as `rocento-provisioning-alerts.service` and
`rocento-provisioning-alerts.timer`. Configure the recipient before enabling it.
Run `provisioning-alerts.py --test` only with authorization to send the test message.
SMTP acceptance does not establish inbox delivery. Private deduplication records
are under `/opt/rocento-onboarding/alerts/`; do not delete them to force retries.

## Staff dashboard deployment

Back up PostgreSQL and retain the running API image before applying migration 006. Build `api` and `ops`, run `api migrate`, and explicitly enrol the verified owner account in `staff_members`. Start the new API and ops services, reinstall the merchant worker, and install `tenant_controls.py` as `/usr/local/lib/rocento/tenant-controls.py` (root-owned, mode 755). Install `tenant-controls.service` and `.timer` as `rocento-tenant-controls.*` under `/etc/systemd/system`, then enable the timer. Install `ops-nginx.conf` under `/etc/nginx/conf.d`, validate nginx, and reload. Existing wildcard DNS and origin TLS cover `ops.rocento.com`; no per-client DNS change is needed.

The controller retains the local deployment lock; remote node restrictions share that node’s deployment lock with provisioning. It stops exact tenant containers without deleting their volumes and records completion only after host actions succeed. Monitor `journalctl -u rocento-tenant-controls.service` and FAILED commands. Do not drop migration 006 while these services are installed. Executor source changes require fresh release evidence; never reuse stale artifact/tool checksums to approve a release.


## Merchant fleet: AWS, Google Cloud and Hetzner

This implementation is repository code, not a deployed fleet. The controller
stays on the existing onboarding host; merchant VMs contain only merchant
runtime components. Staff with OWNER access choose AWS, Google Cloud or Hetzner
in **Clients → Manage → Hosting**. VIEWER remains read-only. Payment may be
confirmed separately; an unselected paid store waits for staff selection.
Selection locks when a job is running or a server slot is reserved. Changing an
existing store's provider requires a separate data migration, not this selector.

Migration 007 records the provider on each tenant, hosts in `merchant_hosts`, and
one durable numbered slot per merchant in `merchant_placements`. The allocator
serializes decisions per provider and reuses compatible hosts with fewer than
three reservations. A fourth merchant reserves another host. Hosts are grouped
by provider, immutable machine profile and release digest, so a different release
can require another host even with unused slots in an older release's pool.
`maxHosts` is a separate per-provider spending limit, not the per-server merchant
limit. Raising it does not change existing host identities. Failed, suspended and
archived stores retain slots; failed hosts still count toward the spending limit.
There is no automatic host deletion, failover, store movement or cross-provider
fallback.

For a bounded initial rollout, a provider profile may include `allowedTenantIds`
with a nonempty list of canonical tenant UUIDs. The controller rejects other
tenants before reserving capacity and filters boot eligibility to this list.
The list participates in the profile digest: changing it invalidates a pending
host's authorization before Terraform apply. A one-tenant list limits that
profile's rollout to one store; `maxHosts: 1` alone does not. This restriction
does not grant release approval or change existing stores. Expanding the list
requires capacity evidence for the resulting colocated workload and review of
the changed profile. Omitting it preserves the general three-slot allocator.

On the controller, a root operator can run
`python3 /usr/local/lib/rocento/merchant_fleet.py observe <tenant-uuid>` during
launch observation, including when new provisioning is disabled. The fixed SSH
endpoint returns only the assigned tenant's container health, restart/OOM state,
available memory/disk, and checkout latency/error samples from the last 60 seconds.
It verifies the host, tenant, release and container project/image bindings. It
does not expose a shell, runtime environment, credentials or raw logs. An empty
sample window is unmeasured, never a latency pass; a truncated log window or
stale/unavailable observation requires investigation. Pair this with real HTTPS
readiness probes because application logs cannot count failures before the gateway.
The operations dashboard refreshes job state every 15 seconds and displays its
last refresh time; it is not a substitute for runtime latency/error observation.
New fleet hosts retain Docker's JSON log format with rotation at 20 MiB and five
files per container, preventing unlimited container-log growth. The observer
reads at most 50,000 lines from the last minute and reports truncation rather than
claiming complete latency coverage when that bound is reached.

Terraform is a required part of core fleet onboarding. PostgreSQL owns provider
choice, payment authorization and the three-slot allocator; Terraform owns each
new VM. New cloud instances are named `merchent-<subdomain>` using the store in
the first reserved slot (for example, `merchent-acme`). The name is sealed in the
Terraform inputs; additional stores sharing the host do not rename it. UUID tags
and state keys continue to identify the host. Apply the matching AWS foundation
IAM policy before deploying this controller/module update.
The merchant executor owns application deployment and suspension. There
is no direct cloud-create fallback and no Terraform execution in staff HTTP requests.

The controller reserves a host during RELEASE after checking the approved
release. `rocento-merchant-fleet.timer` processes requested hosts asynchronously.
It records CREATING, prepares one Terraform workspace per host, initializes the
locked S3 backend, saves a plan, and accepts only one expected VM create. Updates,
deletes, replacements, additional resources and incomplete plans are rejected.
Current payment/account/store/release authorization and release evidence are
checked again immediately before applying that saved plan. Fleet enablement,
provider availability, profile compatibility and backend identity are also
rechecked after planning. The saved plan digest must still match before apply. Provider versions and
checksums are committed; module and lockfile hashes are part of host compatibility.
The modules validate UUID identity, cloud-init format and pinned provider
profiles directly. The modules use deletion protection and `prevent_destroy`; onboarding never
runs destroy, import, refresh-only apply or automatic replacement.

The encrypted S3 state key is `<keyPrefix>/<provider>/<host UUID>.tfstate` for all
three providers. State locking is mandatory. The backend bucket must already
exist; the onboarding worker does not bootstrap its own state storage. This
means Google Cloud and Hetzner creation also needs access to the controller's
AWS state bucket. Each host's binding records its backend, module, release and
profile identity, rejecting changes rather than silently switching state.

After an interrupted/failed apply, the reconciler reads Terraform state and then
verifies the live VM identity using read-only cloud discovery. It never replays
apply or adopts an unrecorded VM automatically. A missing state record, orphan VM,
stale lock, tainted state or uncertain outcome needs operator reconciliation.
Workspace variable/backend inputs are sealed and unexpected Terraform override
files are rejected. A timeout terminates the CLI and its provider process group;
any cloud-side outcome still requires state/identity reconciliation. Creation/bootstrap
has a 30-minute deadline; the timer has its own fleet lock so long Terraform work
does not hold the merchant deployment/control lock. Prepared hosts are reused
without another apply until their three slots are full.

Pinned SSH verifies the node and installed tool hashes before TLS/SMTP transfer.
Disabling fleet creation still permits suspension/archive controls for assigned
hosts using the configured SSH identity. Networking and image settings remain
in the reviewed AWS/GCP templates or Hetzner profile/firewall IDs; this worker
creates servers from them rather than changing shared networks during onboarding.

### Prepare Ubuntu and pinned CI releases before enabling

These are deployment prerequisites; repository checks create no cloud resources.

1. Back up the control PostgreSQL database and apply migration 007 before installing
   the updated API, staff UI, executor or controls. Preserve existing merchant
   files and volumes. Existing local runtimes are not automatically migrated.
2. Use an official **Ubuntu 24.04** base image, pinned by immutable ID. AWS uses
   a versioned launch template prepared by the [AWS foundation](../../cloud/providers/aws/README.md#merchant-onboarding-aws-foundation-prepared-not-deployed);
   GCP uses an immutable instance template with the exact Ubuntu image version;
   Hetzner uses the numeric ID of its standard Ubuntu 24.04 image. No custom
   snapshots, application AMIs, or image builders are required. Select exactly 4 vCPUs and
   16 GiB RAM, adequate durable disk, controller-only SSH and Cloudflare-only
   HTTPS. Preserve the existing network/template and provider identity checks.
3. Run the **Build merchant release candidate** GitHub Actions workflow at the
   intended commit. It builds amd64/arm64 candidates, records source fingerprints,
   exports immutable Docker image IDs and frontend artifacts, and uploads an
   **unapproved** bundle. On the dedicated qualification runner, safely unpack the
   selected architecture's artifact, load `images.tar`, install its matching node
   tools, and install its `release/` directory under the inventory digest. Run the
   existing candidate/runtime/security review; retain the original inventory and
   approval evidence. CI build success is not release approval.
4. Run **Publish reviewed merchant release** at that same commit on the dedicated
   `merchant-release` self-hosted runner, passing the reviewed inventory digest and
   environment. Configure the GitHub `merchant-release` environment with required
   reviewers before use; never allow pull requests to use this runner. Publishing
   validates the existing readiness packet and source manifest, then creates a
   uniquely tagged private release containing `merchant-release.tar.gz` and
   `release-pin.json`. Copy its numeric asset ID, bundle SHA-256, full source commit,
   repository and inventory digest into the provider profile's `release` object.
   Install the identical reviewed inventory/artifacts/packet on the controller.
   Use separate pins for each architecture/environment. Assets larger than 2 GiB
   are rejected; reduce the release footprint before publishing.
5. Install a reviewed Terraform CLI (>=1.10,<2; local/CI verification uses 1.14.0)
   on the central host. Prepare a private, versioned S3 state bucket with encryption,
   public access blocked and least-privilege state/lock access. Configure `terraform`
   in `fleet.json`: `bucket`, `region`, and a unique `keyPrefix` per environment.
   Keep state and saved plans private: they contain generated SSH host keys.
   Install the updated `install-merchant-worker.sh` on the central host. It installs
   fleet modules and timer files but **does not enable the fleet timer**. Copy
   `fleet.json.example` to `/etc/rocento/merchant-provisioning/fleet.json`, fill
   real immutable Ubuntu template/image IDs (Hetzner image and firewall IDs must be
   positive JSON integers), regions, environment names and explicit
   per-provider `maxHosts`, then keep it root-owned mode 600. Remove unused
   provider profiles. Replace every placeholder, including Hetzner firewall IDs.
6. Generate a dedicated Ed25519 controller key pair at the configured paths.
   Keep the private key mode 600. Configure AWS CLI credentials with scoped
   instance creation/tagging/protection/describe/template access and S3 state
   permissions. Configure Google Application Default Credentials for Terraform
   and the GCP CLI read identity for discovery, both scoped to the same project.
   The Google identity needs instance creation/protection, listing and template
   access. Configure the Hetzner token in its private
   token file. The root fleet service uses these credentials; merchant nodes
   receive none. The API staff selector accepts provider names only, never cloud
   credentials, machine IDs, commands or network settings.
7. Configure a private Cloudflare token scoped to DNS editing for the Rocento zone.
   Exact paired merchant A records are created with `proxied=true`, pointing to
   the assigned host. Existing wildcard and unrelated records are preserved.
   An existing exact record must already carry this merchant's ownership marker
   and match its address/type/proxy setting; conflicts require operator review.
   DNS is created only after runtime deployment, before public HTTPS validation.
8. Verify Ubuntu bootstrap, release installation and capacity in each provider/environment. Only after
   that review, set `enabled: true`, reload systemd and enable
   `rocento-merchant-fleet.timer`. The worker will start reserving new hosts for
   eligible paid stores. No provider has an implicit default.

Create a root-owned mode-600 `githubTokenFile` on the controller, with read-only
Contents access to the private release repository. It is never sent to the VM,
Terraform, saved plans or logs. The controller downloads the exact asset ID through
GitHub's release API, removes authorization on the asset-host redirect, and checks
SHA-256 before transferring bytes over pinned SSH. Keep enough controller and node
disk space for the compressed bundle, extraction, Docker load and runtime data.

Cloud-init installs the Ubuntu runtime and enables the metadata firewall **before
Docker starts**. The fixed bootstrap endpoint is embedded in user data and checked
by hash before transfer. It rejects unsafe archives, verifies the bundle, inventory
and source revision, installs prebuilt images, and runs the existing release policy,
architecture, image-ID and artifact checks before handing off to the normal node.
The controller still checks installed tool hashes before transferring TLS/SMTP.
The 30-minute boot deadline and creation-only Terraform policy remain unchanged.
No merchant host compiles source or pulls a moving Git branch.

The generated cloud-init contains a unique per-host SSH host key, a controller
public key constrained to the fixed node endpoint, and host identity. Treat
provider user-data and `/opt/rocento-merchants/fleet/` as private. The controller
pins that exact host key for the first and every subsequent SSH connection; it
never uses trust-on-first-use. TLS/SMTP inputs are sent only over pinned SSH after
boot. The persistent firewall blocks container traffic to metadata addresses,
including user-data access, before Docker starts. The node checks the host ID,
provider, environment, release digest and live lease expiry on provision calls.

### Operations and recovery

Store details show provider, assigned host UUID and host state. The staff job
view distinguishes missing provider/configuration, host preparation, provider
host limit and host review blockers. Inspect `merchant_hosts.error_code` and the
private systemd journal for host failures; no credentials or provider response
bodies are exposed through staff APIs. Monitor the fleet timer separately from
the existing merchant-worker alerts, which do not yet cover fleet-service outages.

Suspension/archive routes to the assigned remote host and records completion only
after that node confirms the runtime stopped. A host with an unreachable address
requires review, even if provisioning never completed. Volumes and reservations
are retained. Unplaced/legacy stores keep the existing local controls behavior.

Before recovering a failed host, disable the fleet timer and reconcile its exact
Terraform state, provider UUID label/name, provider reference, address, persisted
SSH keys and any merchant runtime. Workspaces remain privately under
`/opt/rocento-merchants/fleet/<host UUID>/terraform/`. Preserve `binding.json`,
`backend.json`, the lockfile, state versions, saved plan and `apply-intent.json`.
For bootstrap failures, also preserve `/opt/rocento-bootstrap/install-intent`,
its `ready` marker if present, cloud-init logs and the pinned bundle. An interrupted
installation is not replayed automatically; inspect installed tools, release files,
images and policy evidence before operator recovery. Do not remove an install marker
to force a retry. A partial installation never becomes READY.

Do not delete host/placement rows or the apply marker to force a retry. Never
force-unlock state without proving the lock owner is no longer running.

If a VM exists but Terraform did not record it, an operator must review/import
that exact VM into the original host state before returning the host to BOOTING.
If creation definitely produced no resources, resetting REQUESTED and preparing a
new reviewed apply is an operator recovery procedure, never a customer retry.
Existing direct-API fleet records are not silently adopted: the Terraform module
fingerprint changes compatibility; reconcile/import any such records explicitly.
Do not reset merchant jobs with ambiguous execution without checking remote state.
Host IP changes and provider migrations require explicit ingress/data recovery;
there is no automatic DNS reassignment or live migration in this increment.

### Verification scope

`test_fleet_release.py` checks immutable pins, credential stripping on redirects,
bundle integrity, archive safety, the EC2 user-data size limit, firewall ordering,
and interrupted installation behavior. The release workflows are checked with
`actionlint`; `.github/actionlint.yaml` declares the dedicated runner label.

`test_fleet_terraform.py` tests saved-plan policy, state ownership, credential
handling, reauthorization and interrupted-apply recovery. Each Terraform module
also has a mock-provider `terraform test` plan and schema validation in CI.
`test_merchant_fleet.py` uses mocked provider/SSH/DNS calls to check
creation-intent ordering, uncertain-create discovery, pinned SSH identity, DNS
ownership conflicts, remote controls and lease checks. The PostgreSQL foundation
suite checks staff authorization, provider locking, concurrent reservations,
three-slot constraints, provider separation, host-budget blocking and migration
reruns. The operations browser scenario exercises the provider selector. These
checks do not establish live AWS/GCP/Hetzner Ubuntu boot, credentials, DNS, public
HTTPS, metadata firewall or capacity acceptance. No cloud deployment was performed.

Terraform contracts: [S3 state locking](https://developer.hashicorp.com/terraform/language/backend/s3),
[AWS instance](https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/instance),
[Google instance from template](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/compute_instance_from_template),
[Hetzner server](https://registry.terraform.io/providers/hetznercloud/hcloud/latest/docs/resources/server).

Read-only discovery contracts: [AWS DescribeInstances](https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeInstances.html),
[Google instances.list](https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances/list),
[Hetzner Cloud API](https://docs.hetzner.cloud/reference/cloud).
