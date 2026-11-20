# Deployment host compatibility commands

This directory contains the established deployment-host entry points. Moved
commands forward to their canonical implementations in
[`cloud/host/`](../../../cloud/host/README.md); remaining host helpers and
compatibility commands stay here. The [AWS launcher](../../../cloud/providers/aws/README.md)
and [GCP launcher](../../../cloud/providers/gcp/README.md) use these paths.
Keep the repository path and its `/opt/rocento/deploy/ec2/server/` mirror stable
until callers and installed services are migrated together.

## Find the right command

| Need | Entry point | Notes |
| --- | --- | --- |
| Activate a full platform release | `ec2-up.sh` | Compatibility command for `cloud/host/deploy.sh`; requires a qualified candidate and protected host configuration |
| Run a store's Docker Compose command | `ec2-compose.sh` | Compatibility command for `cloud/host/compose.sh`; used by diagnostics, seeding, and service tools |
| Deploy selected AI services | `ec2-deploy-ai.sh` | Compatibility entry point to `cloud/host/deploy-ai.sh`; requires an existing installation |
| Deploy rengine | `ec2-deploy-rengine.sh` | Compatibility command for `cloud/host/deploy-rengine.sh`; uses the existing deployment configuration |
| Publish the corporate website | `ec2-publish-website.py` | Compatibility command for `cloud/host/publish_website.py`; requires a verified export |
| Seed demo stores | `ec2-seed-demo.sh` | Compatibility command for `cloud/host/seed-demo.sh`; separate from release activation |
| Inspect the current installation | `ec2-status.sh`, `ec2-doctor.sh` | Compatibility entry points to the canonical read-only commands in `cloud/host/`; see [diagnostics](../../../tasks/diagnostics.md) |

The workstation launchers handle target selection, source transfer, and job
monitoring. Host commands handle activation under the deployment lock. Shared
helpers in this directory include `repository-root.sh` for path discovery.
`ec2-bootstrap.sh` sources the canonical protected-config reader from
`cloud/host/bootstrap.sh`.
`cleanup.py` forwards to the canonical bounded cleanup implementation in
`cloud/host/cleanup.py`.
`ec2-preserve-ai.py` forwards to the canonical AI identity verifier in
`cloud/host/preserve_ai.py`.
`ec2-deploy-job.py` forwards to `cloud/host/deployment_job.py`; the read-only
network/readiness checker lives in `cloud/host/check.py`, and `ec2-check.py`
forwards there.
`ec2-source-filters.sh` forwards to the
[shared source filter](../../../cloud/lib/source-filters.sh) for compatibility with
installed host paths. Do not invoke helpers as independent release procedures.

Start with the [deployment map](../../README.md), then use the relevant
[AWS](../../../cloud/providers/aws/README.md) or [GCP](../../../cloud/providers/gcp/README.md) guide. The
[EC2 operator guide](../README.md) documents the protected host layout.
