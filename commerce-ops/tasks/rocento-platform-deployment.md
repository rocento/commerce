# Rocento platform deployment

Use this workflow to deploy Rocento's own production site and managed demo
stores. This is separate from customer onboarding and from local development.

## Entry points

- Workstation launcher and operator instructions:
  [`cloud/providers/aws/README.md`](../cloud/providers/aws/README.md)
- EC2 provisioning and server lifecycle:
  [`deploy/ec2/README.md`](../deploy/ec2/README.md)
- Deployment boundaries and included source:
  [`deploy/README.md`](../deploy/README.md)

The normal AWS workflow stages application source, then runs the server release
gate and promotes reviewed artifacts. Demo catalog or delivery-area updates use
the separate seed launcher described in the AWS guide.

For the workstation interface, define an explicit named target using
the [target rules](../COMMANDS.md#named-targets-and-precedence). Inspect the
offline upload outline, check release readiness separately, then invoke the
existing launcher:

```sh
python3 commerce-ops/bin/ops cloud plan --target production-aws --candidate "$CANDIDATE_SHA" --packet commerce-output/release/packet.json
python3 commerce-ops/bin/ops cloud deploy --target production-aws
```

The GCP target uses `production-gcp` and the same host activation gate. Direct
provider scripts remain callable during migration.

## Ownership and compatibility

- Application code remains in `commerce-api/`, `commerce-web/`, and
  `commerce-assistant-platform/`.
- Canonical host implementations are in `commerce-ops/cloud/host/`; service
  assets are in `commerce-ops/services/` and definitions in `commerce-ops/compose/`.
- The server retains protected generated/runtime state under `/opt/rocento/`.
  Server command copies remain under `/opt/rocento/deploy/ec2/server/` for
  compatibility; do not move runtime paths as part of a source organization
  change.
- Keep workstation credentials and keys out of staged source and uploads.

Do not use this production workflow for onboarding feature work or routine
local stack startup.

## Upload, activation and cleanup

Run these commands on your Mac. Cleanup runs automatically on EC2 before the
disk check, under the deployment lock. The uploader includes `commerce-ops/cloud/host/cleanup.py` with the server source;
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
bash commerce-ops/cloud/providers/aws/deploy.sh --dry-run
```

The preview requires an existing remote checkout. It omits protected configuration
contents and cannot be combined with local language export options.

During activation, the server synchronizes canonical `commerce-*` source paths
with `ubuntu:ubuntu` ownership under the deployment lock. Protected runtime
configuration and state under `/opt/rocento/deploy/ec2/`, including secrets,
generated configuration, `setup.lock`, and seed markers, remain separate from
uploaded source.

Cleanup retains the active frontend release and removes obsolete managed releases.
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
