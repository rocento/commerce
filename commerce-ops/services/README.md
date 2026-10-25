# Service deployment assets

This directory owns runtime implementations and installation assets for
services operated by `commerce-ops`. Host workflows install or configure these
assets; provider launchers handle access and source transfer.

| Service | Contents | Host integration |
| --- | --- | --- |
| Assistant | Image definitions, proxy configuration, shared tenant SQL, database migration helper, and initialization assets | Compose builds/mounts these files; full and AI-only uploads include the required assets. |
| Health dashboard | Installer, Nginx configuration, systemd units and collector timer | `health-dashboard/install.sh` installs assets; API and collector code stay in `commerce-api/health-api/`. |
| Observability | Collector, metrics, traces, logs, alerts and Grafana provisioning | `compose/components/compose.observability.yaml` mounts these assets. |
| Rengine | Nginx configuration and host connection setup | Full and rengine-only uploads include this directory; runtime stays in `commerce-web/apps/rengine/`. |
| [Native preview](native-preview/README.md) | Simulator workers, capture adapters, packaging, and the AWS controller | Independent worker packages and controller installer; excluded from normal platform uploads. |
| [Contact](contact/README.md) | HTTP handler, systemd unit, and standalone activation script | Full host deployment installs the handler and unit; managed uploads include the service package. |

Keep application APIs and domain logic with their application repositories.
Use this directory for a service implementation only when operations owns its
runtime, and document its installer and dependencies alongside that service.

## Source and runtime paths

Use `commerce-ops/services/<service>/` in new consumers. The corresponding
`deploy/` source aliases have been removed. Existing host files
under those paths remain protected during activation until their installed
consumers have been audited. Platform service assets are uploaded under `services/`; native preview uses
its own explicit installation workflow.

Generated host configuration, credentials and data remain under their existing
`/opt/rocento/deploy/` runtime paths. Moving source does not migrate that state.
Native preview lives under `services/native-preview/`; its controller lives in
`aws-controller/`. Their standalone installers preserve existing host runtime
paths under `/opt/rocento-preview-control` and the worker service configuration.
