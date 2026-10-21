# Commerce operations

This area owns shared local infrastructure, release and deployment tooling,
onboarding development dependencies, and operator runbooks. Product code stays
with its service owner; operations guides point to that owner instead of copying
its implementation.

## Start by task

| Task | Start here | Main owner |
| --- | --- | --- |
| Run the commerce platform locally | [Local development](tasks/local-development.md) | `commerce-ops/compose/`, `commerce-ops/scripts/local/` |
| Develop customer onboarding | [Onboarding](tasks/onboarding.md) | `commerce-api/onboard-api/`, `commerce-web/apps/onboarding/` |
| Deploy Rocento platform to production | [Rocento platform deployment](tasks/rocento-platform-deployment.md) | `commerce-ops/deploy/aws-deploy/`, `commerce-ops/deploy/ec2/` |
| Recover or diagnose operations | [Operations and recovery](tasks/operations-recovery.md) | `commerce-ops/deploy/`, `commerce-ops/scripts/` |

## Directory map

- [`compose/`](compose/README.md) contains the shared Rocento Compose stack and
  overlays. The project identity and existing production runtime paths are
  compatibility boundaries.
- [`scripts/`](scripts/AGENTS.md) contains reusable local, release, deployment,
  seed, and repository maintenance commands.
- [`onboarding/`](onboarding/README.md) contains local infrastructure for the
  standalone onboarding API. The API and web applications remain owned by their
  respective service directories.
- [`deploy/`](deploy/README.md) contains Rocento platform deployment inputs and
  operator tooling. It is separate from merchant onboarding and provisioning.

## Working rules

- Run commands from the repository root unless a task guide specifies a service
  working directory.
- Keep secrets, generated state, and host runtime state out of source uploads.
- Keep deployment operations distinct: a platform release, demo seeding, and
  onboarding feature work have different owners and effects.
- For a new command, place implementation with its purpose under `scripts/`,
  then update the script reference and compatibility entrypoint map if needed.
- Read the nearest `AGENTS.md` before editing a subtree.
