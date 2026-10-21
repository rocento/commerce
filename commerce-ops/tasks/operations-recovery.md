# Operations and recovery

For diagnosis and recovery of Rocento's deployed platform, begin with the
[EC2 operations guide](../deploy/ec2/README.md) and the
[AWS operator guide](../deploy/aws-deploy/README.md). The canonical server
commands are in `commerce-ops/deploy/ec2/server/`; reusable release and
maintenance commands are in `commerce-ops/scripts/`.

Use the deployment job status and recovery procedures documented in those
guides. Preserve `/opt/rocento/deploy/ec2/setup.lock`, generated deployment
configuration, service data volumes, and secrets. Repository cleanup or source
reorganization is not a production recovery action.

For local stack issues, use the [local development guide](local-development.md)
and its `commerce-ai` Compose project. For onboarding API development issues,
use the [onboarding guide](onboarding.md) and its isolated local dependency
stack.
