# Commerce operations

This area owns shared local infrastructure, release and deployment tooling,
onboarding development dependencies, and operator runbooks. Product code stays
with its service owner; operations guides point to that owner instead of copying
its implementation.

## Start by task

| Task | Start here | Main owner |
| --- | --- | --- |
| Run the commerce platform locally | [Local development](tasks/local-development.md) | `commerce-ops/compose/`, `commerce-ops/local/platform/` |
| Develop customer onboarding | [Onboarding](tasks/onboarding.md) | `commerce-api/onboard-api/`, `commerce-web/apps/onboarding/` |
| Prepare a release candidate | [Release preparation](tasks/release-preparation.md) | `commerce-ops/workflows/release/` |
| Refresh demo data | [Demo seeding](tasks/demo-seeding.md) | `commerce-ops/cloud/seed-demo.sh`, provider launchers, `commerce-ops/workflows/demo/` |
| Deploy Rocento platform to production | [Rocento platform deployment](tasks/rocento-platform-deployment.md) | `commerce-ops/cloud/providers/`, `commerce-ops/cloud/host/` |
| Diagnose a deployed platform | [Diagnostics](tasks/diagnostics.md) | `commerce-ops/cloud/host/` |

## Reading order

Start with the task table above. Use [COMMANDS.md](COMMANDS.md) for command syntax,
explicit targets, and effects. Provider guides explain access prerequisites;
task guides own shared procedures. Area READMEs explain source ownership.

For repository refactoring, use the [single current plan](REFACTOR-PLAN.md#current-progress-and-next-priorities).
The [editing guide](AGENTS.md#documentation-ownership) defines lasting documentation
ownership. The plan preserves dated batch results and remaining compatibility
decisions without separate phase reports.

## Directory map

- [`compose/`](compose/README.md) contains the shared Rocento Compose stack and
  overlays. The project identity and existing production runtime paths are
  compatibility boundaries.
- [`local/`](local/README.md) contains platform launchers, isolated onboarding
  dependencies, and workstation preview helpers. The API and web applications
  remain owned by their respective service directories.
- [`workflows/`](workflows/README.md) contains release, demo and maintenance
  workflows. [`tools/`](tools/README.md) owns development checks, generators and evaluations;
  [`tests/operations/`](tests/operations/README.md) owns operations regressions.
  [`scripts/`](scripts/README.md) retains historical evidence harnesses.
  Retired workflow aliases have been removed; use the owning paths directly.
- `cloud/` owns [shared host commands](cloud/host/README.md), transport, and
  [AWS](cloud/providers/aws/README.md)/[GCP](cloud/providers/gcp/README.md) adapters.
- [`services/`](services/README.md) groups operations-owned service runtimes and
  their installation assets; application-owned APIs remain with their services.
- [`deploy/`](deploy/README.md) contains classified host bootstrap/reference assets and compatibility
  entry points; canonical implementations live with their documented owners.
- [`tasks/`](tasks/README.md) routes common work to the owning guide and command.
- [`bin/ops`](bin/ops), [`commands.json`](commands.json), and
  [`config/`](config/README.md) provide the command interface and safe
  target templates.

## Working rules

- Run commands from the repository root unless a task guide specifies a service
  working directory.
- Keep secrets, generated state, and host runtime state out of source uploads.
- Keep deployment operations distinct: a platform release, demo seeding, and
  onboarding feature work have different owners and effects.
- For a new command, place implementation with its purpose under `local/`,
  `cloud/`, `services/`, `workflows/`, or `tools/` owners,
  then update the script reference and canonical command inventory if needed.
- Extend the owning guide before creating another Markdown file.
- Read the nearest `AGENTS.md` before editing a subtree.

Deployment and maintenance commands do not create backups or automatically restore
previous releases. On failure, inspect the reported stage and correct the current
state before retrying. Historical evidence is retained separately from executable
backup and rollback tooling.
