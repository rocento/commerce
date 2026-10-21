# Rocento platform deployment

Use this workflow to deploy Rocento's own production site and managed demo
stores. This is separate from customer onboarding and from local development.

## Entry points

- Workstation launcher and operator instructions:
  [`deploy/aws-deploy/README.md`](../deploy/aws-deploy/README.md)
- EC2 provisioning and server lifecycle:
  [`deploy/ec2/README.md`](../deploy/ec2/README.md)
- Deployment boundaries and included source:
  [`deploy/README.md`](../deploy/README.md)

The normal AWS workflow stages application source, then runs the server release
gate and promotes reviewed artifacts. Demo catalog or delivery-area updates use
the separate seed launcher described in the AWS guide.

## Ownership and compatibility

- Application code remains in `commerce-api/`, `commerce-web/`, and
  `commerce-assistant-platform/`.
- Canonical deployment inputs are in `commerce-ops/deploy/` and service
  definitions are in `commerce-ops/compose/`.
- The server retains protected generated/runtime state under `/opt/rocento/`.
  Server command copies remain under `/opt/rocento/deploy/ec2/server/` for
  compatibility; do not move runtime paths as part of a source organization
  change.
- Keep workstation credentials and keys out of staged source and uploads.

Do not use this production workflow for onboarding feature work or routine
local stack startup.
