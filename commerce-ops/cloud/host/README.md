# Cloud host operations

This directory owns implementation code that runs on a Rocento deployment
host or renders host configuration. It is shared by AWS and GCP workstation
launchers; it must not read workstation target files, SSH keys, or provider
credentials.

## Current contents

| File | Purpose | Compatibility path |
| --- | --- | --- |
| `render_config.py` | Validates the deployment domain and generates protected Compose and Nginx configuration | `commerce-ops/deploy/ec2/configure.py` is a source symlink; activation installs it as `/opt/rocento/deploy/ec2/configure.py` |
| `status.sh` | Read-only service, database, TLS, and public-route status | `commerce-ops/deploy/ec2/server/ec2-status.sh` forwards here |
| `doctor.sh` | Read-only host, capacity, TLS, DNS, and endpoint diagnostics | `commerce-ops/deploy/ec2/server/ec2-doctor.sh` forwards here |
| `deploy-ai.sh` | Deploys selected assistant and language services under the shared host lock | `commerce-ops/deploy/ec2/server/ec2-deploy-ai.sh` forwards here |
| `shared-ai-upgrade.sh` | Applies the shared AI database preparation required by a selected AI deployment | `commerce-ops/deploy/ec2/server/ec2-shared-ai-upgrade.sh` forwards here |
| `check.py` | Readiness, DNS, HTTPS, and pinned-origin checks used by host commands | `commerce-ops/deploy/ec2/server/ec2-check.py` forwards here |
| `deploy.sh` | Full platform deployment and host reconciliation | `commerce-ops/deploy/ec2/server/ec2-up.sh` forwards here |
| `deploy-rengine.sh` | Deploys the separate rengine service under the shared host lock | `commerce-ops/deploy/ec2/server/ec2-deploy-rengine.sh` forwards here |
| `compose.sh` | Builds the per-store Compose argument set and executes Docker Compose | `commerce-ops/deploy/ec2/server/ec2-compose.sh` forwards here |
| `seed-demo.sh` | Seeds selected demo stores under the shared deployment lock | `commerce-ops/deploy/ec2/server/ec2-seed-demo.sh` forwards here |
| `bootstrap.sh` | Reads protected host bootstrap configuration for deployment and seed workflows | `commerce-ops/deploy/ec2/server/ec2-bootstrap.sh` sources this helper |
| `cleanup.py` | Reclaims disposable caches and inactive managed frontend releases during full deployment | `commerce-ops/deploy/ec2/server/cleanup.py` forwards here |
| `preserve_ai.py` | Records and verifies running AI container, image, and release identities for `--preserve-ai` | `commerce-ops/deploy/ec2/server/ec2-preserve-ai.py` forwards here |
| `publication.py` | Renders the opt-in merchant Nginx configuration | `commerce-ops/deploy/ec2/publication.py` forwards here |
| `activate-source.sh` | Installs a complete managed upload while holding the existing deployment lock | `commerce-ops/deploy/ec2/server/ec2-activate-source.sh` forwards here |
| `deployment_job.py` | Starts, runs, monitors, and resumes a detached deployment job | `commerce-ops/deploy/ec2/server/ec2-deploy-job.py` forwards here |

The seed implementation now lives here. The provider-neutral workstation
launcher uploads it with the selected demo data and refreshes the established
`/opt/rocento/deploy/ec2/server/ec2-seed-demo.sh` compatibility command. It
continues to read protected bootstrap configuration and share the deployment
lock. Full activation mirrors the retained host command directory, preserving
the established installed paths for existing callers.

Frontend artifact building belongs to `commerce-ops/workflows/release/`; the host
deployment only verifies and promotes the reviewed export.

## Runtime boundary

Generated configuration, secrets, state, and the deployment lock remain under
`/opt/rocento/deploy/ec2/`. Source migration must preserve that protected
location, the lock inode, and the existing server command entry points until a
separate installed-path migration is designed. The old bootstrap helper path
remains a source-compatible adapter to `bootstrap.sh`.
