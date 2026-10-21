# Release readiness

Release readiness is an explicit decision for one immutable candidate and one
identified acceptance environment. The evidence gate rejects missing, failed,
skipped, stale, mismatched or altered evidence. Passing CI alone is insufficient.
This process does not deploy, publish, or certify the current working tree.

## Candidate and evidence packet

Create a run using the [output-run helper](../reference/workspace-cleanup.md#retained-evidence).
Keep a release inventory in its evidence directory identifying every deployable
image by registry digest, frontend and language artifacts by hash, migration
set, configuration fingerprint without secrets, architecture, source revision,
and dirty source fingerprint when applicable. Hash the exact inventory bytes
with SHA-256. That hash is the candidate identity supplied independently to the
gate; any inventory change requires new evidence and review.

Create the packet beside that inventory and the sanitized evidence files:

```sh
python3 commerce-ops/scripts/release/release_readiness.py init \
  --packet commerce-output/YYYY-MM-DD-release/evidence/readiness.json \
  --candidate-sha256 <inventory-sha256> --environment <installation-id> \
  --owner <release-owner>
python3 commerce-ops/scripts/release/release_readiness.py check \
  --packet commerce-output/YYYY-MM-DD-release/evidence/readiness.json \
  --candidate-sha256 <inventory-sha256> --environment <installation-id>
```

Replace the path placeholders with the new run's path. Initialization refuses
to overwrite a packet and deliberately starts blocked. Check prints JSON and
returns zero only when the packet passes policy; otherwise it returns one and
lists blockers. Store that result in the run's deliverables and update the run
manifest with the commands, environment, limitations and retained hashes.

Each check needs `status: "passed"`, matching `candidate_sha256` and `environment`,
the exact `command` or review procedure, `reviewer`, explicit `coverage`, a
UTC/offset `completed_at` timestamp, and a nonempty `evidence` array. Each evidence
entry contains a packet-relative `path` and its lowercase SHA-256 `sha256`.
Absolute paths, traversal, symlinks, missing files and checksum changes fail.
All results must be at most 72 hours old, with no future timestamps. Checks have
no skip or waiver mechanism. Use the deployment acceptance installation as the
packet environment; describe disposable test environments in coverage rather
than suggesting that unit tests ran on production.

## Required coverage and accountable reviewers

| Check ID | Evidence the service/release reviewer must verify |
| --- | --- |
| `service-ci` | All required automated service checks succeeded for the candidate source; use CI or recorded local equivalents. Generated contracts and migrations are consistent. |
| `commerce-image` | Exact candidate architecture/image verified with disposable providers, checkout invariants, worker health and outage recovery; see [commerce reliability](commerce-reliability.md). |
| `browser-journeys` | Customer login, cart, checkout and order confirmation; admin permissions and order handling; enabled assistant journeys against identified services. |
| `tenant-isolation` | Cross-tenant access, delegated scopes, authentication and private/public ingress rejection tests. |
| `security-review` | Candidate dependency/container/secret scan results, reviewed findings, and resolution of release-blocking vulnerabilities. Record scanner databases and policy; no unsupported claim of certification. |
| `migration-upgrade` | Upgrade from the supported existing schema on an isolated sanitized copy, checksum validation and compatibility with the planned rollout sequence. Fresh empty databases alone do not qualify. |
| `backup-restore` | Recent isolated restore exercise, integrity checks, measured recovery time and data-loss window against agreed RTO/RPO; see [durability](durability.md). |
| `recovery-plan` | Reviewed rollback or forward-recovery procedure, immutable prior artifacts, database compatibility, abort criteria and responsible operator. A plan is not evidence of a rollback rehearsal. |
| `capacity` | Representative workload, resource limits, latency/error objectives, observed results and headroom. Debug microbenchmarks do not establish production capacity. |
| `observability` | Alert routing verified, dashboards and freshness signals available, owner/on-call coverage, quantitative abort thresholds and a defined observation window. |
| `deployment-acceptance` | Controlled installation of the exact artifacts, migration/readiness checks and synthetic critical journeys through real ingress. Include external delivery/provider coverage where enabled. |

The gate verifies evidence integrity and required metadata, not the truth of an
arbitrary report or a reviewer's identity. Reports must come from trusted CI or
accountable operators; reviewers inspect their contents and confirm the scope
above. Keep packets in access-controlled release storage. Hashes are not digital
signatures. Retain original CI run URLs/identities and candidate inventory in the
evidence. Never put credentials, raw customer data or private build logs in a
shared packet.

## Decision and promotion

After all checks, a reviewer distinct from `owner` records `approval` with
`reviewer`, `candidate_sha256`, `environment`, and `approved_at`. Its timestamp
must follow all check timestamps and must not be in the future. Re-run the gate
immediately before promotion. Candidate or environment changes invalidate the
packet; evidence expiry requires rerunning the affected verification.

When a hosted repository exists, configure **Required CI** as a required repository check. Its always-running
aggregator fails on failed, cancelled or skipped prerequisite jobs. Configure
**Commerce release verification / verify** as required for its applicable
changes using repository rules appropriate to that workflow's path filters.
Branch protection and deployment-environment permissions require repository
administration; workflow files do not enable them automatically. When adding a
CI job, also add it to the aggregator's `needs` list.

This installation currently has no hosted Git repository. Run the owning service guides’ checks locally against the exact source inventory and retain commands, tool versions, results and reviewer identity for `service-ci`. Hosted branch/environment protection is not an available control; the root-owned production authorization remains mandatory.

Required CI validates source checks and the evidence-policy regression tests.
It does not create operational evidence or install authorization on production.

## Enforced production promotion

Full source activation, direct full deployment, partial AI deployment, diagnostics
deployment, and standalone website publication require the server-side
`deployment_gate.py`. Full activation checks under the deployment lock before
mirroring source, installing configuration or cleanup. Direct deployment checks
before preflight and again under its lock. Read-only `--verify-only` and website
`--dry-run` remain available without release authorization.

The gate reads only `/etc/rocento/release/authorization.json`, with sibling
`inventory.json` and `readiness.json`. Authorization, inventory, evidence files,
and their parent directories must be root-owned, not group/world writable, and
not symlinks. Ordinary source uploads cannot populate this directory. There is
no skip-gate flag or environment-variable bypass. This does not constrain a root
administrator who deliberately runs Docker or SQL outside these entry points.

Authorization contains `candidate_sha256` (hash of the inventory's exact bytes),
`environment`, and `machine_id_sha256` (hash of the target's `/etc/machine-id`).
The inventory binds operation (`full`, `ai`, `rengine`, or `website`), selected
service/store, preserve-AI mode, and source-file hashes. Full deployments also
bind the bootstrap file hash; website deployments bind their destination domain.
A different host, scope, source tree, expired evidence or altered report blocks
promotion. Source inventory uses the same full-upload filters and includes the
separately mirrored migrations. Partial inventories cover their selected inputs.

Production now **promotes preverified artifacts without rebuilding them**.
`image_ids` must contain the exact local Docker content ID for every required
application image: backend and, unless preserving AI, assistant, language engine
and AI PostgreSQL for full deployment; selected assistant/language images for
AI deployment; diagnostics image for rengine. Load the qualified images with
`docker load` or pull the reviewed registry digest and verify its local ID. Moving
a `:release` tag to another image blocks the gate. The full frontend export lives
in `/etc/rocento/release/frontend`; `commerce-web_files` records every relative file
and SHA-256. Its copied bytes are checked again before ingress changes. Existing
`--no-build` is compatible; `--rebuild` is rejected in production. Build/qualify
artifacts separately with the existing Dockerfiles and frontend build recipe.

Generate a draft inventory from the final prepared source, already qualified
images, bootstrap file, and complete frontend export:

```sh
python3 commerce-ops/scripts/release/deployment_gate.py inventory --operation full   --source . --bootstrap commerce-ops/deploy/aws-deploy/bootstrap.env   --capture-images --frontend /path/to/reviewed-public-export > inventory.json
```

For an AI inventory supply `--operation ai --service all --store all`, or the
exact selected scope. For diagnostics use `--operation rengine`. For a website
export use `--operation website --source /path/to/export --domain rocento.com`.
Inventory generation alone grants no approval. Finish the evidence packet and
independent review for the inventory hash before an authorized operator installs
the packet, evidence, frontend export and authorization in the root-owned server
directory. Provision Docker and required provider images before initial use.
The normal application uploader deliberately does not install approval files.

This gate checks application artifact identity. Provider image pinning, private
runtime configuration, registry provenance/signatures, actual reviewer identity,
and repository/environment access rules still require operator-controlled
configuration and review. Keep the authorized directory unchanged while a
release runs. The gate is rechecked at artifact use; a rejected or expired release
can leave earlier, already completed store updates applied. Recovery remains an
explicit operator action, never an automatic database rollback.

## Recommended initial objectives

These are proposed launch thresholds, not claims about current measured capacity:

| Area | Acceptance objective |
| --- | --- |
| Availability | 99.9% successful critical user journeys over a rolling 30 days |
| Order integrity | No lost acknowledged orders or duplicate purchases after ordinary process crashes and retries |
| Disaster recovery | RPO at most 5 minutes; RTO at most 60 minutes, including validation and traffic restoration |
| Capacity | 100 concurrent synthetic shoppers per store for 30 minutes; test all colocated stores together and a 2× burst |
| Checkout API | p95 at most 1 second, p99 at most 2 seconds; unexpected transport/5xx errors below 0.1% |
| Rollout | Observe a limited rollout for at least 30 minutes; stop on any integrity/isolation violation, sustained SLO breach or missing telemetry |

Review workload arrival rate, catalog size, geographic network latency and order
mix before treating this as a contractual SLO. A short closed-loop eight-shopper
run is correctness evidence, not this capacity qualification. Zero-loss crash
recovery does not imply zero data loss after destruction of a single host. The
existing single-host durability topology needs independently stored backups and
measured disaster restoration before claiming the disaster targets.

The objectives follow the customer-journey approach in
[Google's SLO guidance](https://sre.google/workbook/implementing-slos/) and the
business-impact approach to [AWS recovery objectives](https://aws.amazon.com/blogs/mt/establishing-rpo-and-rto-targets-for-cloud-applications/).
The numeric thresholds above are this project's recommended starting point.

## App Studio stage-limited promotion

For the explicitly user-authorized App Studio stage that defers backups and
 disaster recovery, `commerce-ops/scripts/release/app_studio_stage.py` provides a separate,
 reviewed gateway-and-ingress promotion path. This does not satisfy or weaken the
 full release gate above. It records backup/DR as deferred and capacity as
 unqualified; it does not certify general production readiness.

The supported scope is deliberately fixed: the grocery gateway serving App
 Studio, the asset route allowlist, and folder migration `20261015150000` on the
 supported 102-migration ledger. Workers, AI services, frontend exports, other
 store services and unrelated configuration must retain their reviewed identities.
 No source activation, build, storage expansion or database restore occurs.

The operator installs the self-contained executable at
 `/usr/local/lib/rocento/app-studio-stage/app_studio_stage.py` and runs it with
 `python3 -I`. The executable, authorization, inventory, evidence and scripts must
 have root-owned, non-symlink, non-group/world-writable path chains. Authorization
 is `/etc/rocento/release/app-studio-stage.json`, binding the SHA-256 of its sibling
 `app-studio-inventory.json`, distinct operator/reviewer identities, review time
 and expiry within 24 hours. The inventory binds the executable hash, exact image
 and binary hashes, truthful layered source provenance, migrations, current host
 state, prior/candidate ingress, acceptance code, and focused evidence. Build
 labels inherited from a base image do not establish new gateway provenance.

Required focused reviews cover exact candidate runtime, banner schema, asset
 ownership, migration upgrade, fallback compatibility, security, and activation.
 Check evidence must be fresh, hash-verified and bound to both candidate and
 fallback. Review the actual reports; metadata alone does not establish success.
 A compatible fallback must start after the new migration is applied. Restoring
 an older image lacking that embedded migration is not a valid recovery plan.

`python3 -I /usr/local/lib/rocento/app-studio-stage/app_studio_stage.py snapshot`
 captures state without promotion. `check` validates the installed packet against
 the current state. `apply` acquires the existing deployment lock, checks drift,
 requires 2 GiB free for this prebuilt activation, syntax-checks the minimal
 ingress update, replaces only the gateway, and runs reviewed public acceptance.
 This headroom requirement applies only to the prebuilt narrow operation, not to
 the full deployment's build-space guard. Failed acceptance attempts both
 compatible gateway recovery and prior ingress restoration, then verifies them.
 Keep the operator present for the acceptance and recovery result. Retain the
 output and verify preserved services and public draft behavior; do not publish
 a merchant configuration as part of this operation.
