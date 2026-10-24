# Rocento deployment map

Compatibility boundary: do not add new command implementations here. Use the
canonical `local/`, `cloud/`, `services/`, `workflows/` or `tools/` owner.
Retained historical harnesses, installed adapters and deployment assets keep
their documented ownership until their consumers migrate.

These directories deploy and maintain Rocento's own production site and its
four managed demo stores: Grocery, Jewelry, Electronics and Pharmacy. They are
not a client onboarding package.

## Repository areas

| Area | Purpose | Production handling |
| --- | --- | --- |
| `commerce-api/`, `commerce-web/` (including rengine), `commerce-assistant-platform/` | Rocento application and runtime source | Included by the matching deployment workflow |
| `commerce-ops/compose/` | Rocento service definitions | Managed Compose files are uploaded with their services |
| [`commerce-ops/cloud/providers/aws/`](../cloud/providers/aws/README.md) | AWS workstation launchers, public templates and operator guides | Launcher code stays on the workstation; private values live under ignored `.local/commerce-ops/` paths |
| [`commerce-ops/deploy/ec2/server/`](ec2/server/README.md) | Established deployment-host compatibility commands used by AWS and GCP | Mirrored to the server; installed paths remain under `/opt/rocento/deploy/ec2/server/` |
| [`commerce-ops/deploy/ec2/`](ec2/README.md) | Host templates, protected runtime inputs, and legacy source paths | Generated config and secrets stay in protected host runtime storage |
| [`commerce-ops/cloud/host/`](../cloud/host/README.md) | Canonical deployment-host renderer, operations, and demo seeding | Installed compatibility paths remain under `/opt/rocento/deploy/ec2/` |
| [`commerce-ops/cloud/lib/`](../cloud/lib/source-filters.sh) | Shared transport, job, and managed source filter helpers | The canonical source filter is uploaded; compatibility paths remain during migration |
| [`commerce-ops/cloud/providers/gcp/`](../cloud/providers/gcp/README.md) | GCP workstation launcher and public templates | Uses shared deployment-host commands with a named GCP target |
| `commerce-ops/workflows/` and `commerce-ops/tools/` | Release gates, demo workflows and development tools | Canonical runtime support is included; selected demo helpers are transferred by the separate seed launcher |
| `commerce-demo/` | Demo presets and delivery-area seed data | Excluded from normal production source uploads; copied only by the explicit demo seeder |
| `commerce-assets/demo/` | Demo catalog and category images plus seed helpers | Excluded from normal production uploads; selected assets are transferred by the explicit demo seeder |
| `commerce-docs/` | Engineering and operations documentation | Kept in the repository; excluded from application uploads |

## Service inputs

These folders contain configuration or installation inputs consumed by the
platform deployment. Application implementations stay with their service owners.

Canonical service assets live in [`../services/`](../services/README.md).
`assistant/`, `health-dashboard/`, `observability/`, and `rengine/` are temporary
source compatibility symlinks. Contact already uses its canonical service path.
Native preview and AWS automation are also compatibility symlinks to
`../services/native-preview/` and its `aws-controller/` subdirectory.

Only the paths selected by [`cloud/lib/source-filters.sh`](../cloud/lib/source-filters.sh)
enter managed source uploads. Update that filter when a service input moves.
The former `ec2/server/ec2-source-filters.sh` path remains as a compatibility
wrapper for installed host commands.

The AWS and GCP workstation launchers share SSH and rsync option setup,
transfer retry, and connection cleanup in
[`cloud/lib/transport.sh`](../cloud/lib/transport.sh). This helper runs locally;
target settings and host activation remain with their respective launchers and
server commands.

[`cloud/lib/jobs.sh`](../cloud/lib/jobs.sh) creates each private upload directory,
stages managed source and migrations, and monitors the resulting host job. AWS
uses the existing `--copy-dest` transfer path; GCP uses its direct transfer
path. Provider launchers still upload their own protected configuration and
mark their stage ready before monitoring.

## Production and demo boundaries

Both provider launchers use the host command set under [`ec2/server/`](ec2/server/README.md).
The directory name and `/opt/rocento` host paths are compatibility contracts;
the [AWS](../cloud/providers/aws/README.md) and [GCP](../cloud/providers/gcp/README.md) guides own their
provider-specific target settings.

## Before a production deployment

Production promotion requires a reviewed, root-owned release packet and exact
preverified application images and frontend artifacts. Missing or mismatched
evidence blocks activation. Build and qualify candidate artifacts separately;
the production host does not build them during deployment. Follow the
[release authorization procedure](../../commerce-docs/platform/operations/release-readiness.md#enforced-production-promotion)
for the exact candidate and installation before running either provider launcher.

The provider guides below cover target access, upload, and host setup. Their
commands use the same locked host activation and release gate.

The normal AWS launcher stages application source and migrations, then the EC2
release gate verifies and promotes the reviewed images and frontend export. It
does not build production artifacts or seed demo data. Its upload boundary is
defined in `shared/source-filters.sh` and shared with server activation.

Run the provider-specific seed launcher separately when Rocento's demo
catalogs, themes, or delivery coverage need changes. AWS and GCP launchers call
the shared `cloud/seed-demo.sh` workflow. It transfers only the selected demo
data and seeding helpers, then runs them against the existing Rocento
deployment. It does not upload application source, build images, or restart
services.

Within `commerce-ops/scripts/`, `release/` contains the canonical release gates,
`demo/` contains demo seed workflows, and `tests/` contains repository checks.
Commands run from their purpose folders. `entrypoints.json` lists canonical
paths; update callers and that inventory together when moving a command.

On EC2, `/opt/rocento/deploy/ec2/` remains a protected runtime location for
generated Compose configuration, bootstrap secrets, setup state, and the
deployment lock. Keep it separate from canonical repository source under
`commerce-ops/deploy/`; the server command mirror is retained for existing service
operations.

For the full workflow, see [AWS deployment commands](../cloud/providers/aws/README.md),
[GCP deployment commands](../cloud/providers/gcp/README.md), and [EC2 host provisioning](ec2/README.md).
