# Shared configuration

Copy `.env.example` to a new local `.env` for Compose setup; review and preserve existing settings rather than overwriting them. Keep credentials in private environment/files, never documentation or reports.

| Owner | Canonical configuration guide |
| --- | --- |
| Rust gateway / commerce | [Backend development](../../backend/development.md) |
| Customer storefront / proxies | [Frontend development](../../frontend/development.md) |
| Admin UI / previews | [Admin settings](../../admin-ui/content-and-settings.md) |
| AI identity, models, budgets and persistence | [AI configuration](../../ai-service/configuration.md) |
| Public merchant identity / renderer | [Backend publication](../../backend/publication.md), [renderer](../../frontend/publication.md) |
| Hosted mail | [SMTP setup](../../../commerce-ops/deploy/aws-deploy/SMTP.md) |

## Optional overlays

Compose overlay files are the source for their service bindings and environment inputs. Assistant setup uses tenant-bound signing/verifying keys and separate AI persistence. Private signing keys remain on the gateway side; Python must not receive general commerce credentials. Admin-managed assistant settings and scoped provider tests are described in the AI guide. Model configuration alone does not authorize commerce or make the language resolver ready.

Local notification adapters include console and Mailpit where configured. Startup security depends on the actual environment and selected adapter; do not use the removed console-only historical guidance. Hosted email uses the deployment-owned queue/SMTP setup.

Durability uses the replica/archive/backup overlay; inspect [recovery operations](durability.md) before applying it to an existing installation. Observability uses its configured exporter and log endpoints; see [observability](observability.md). An overlay file or saved setting is not proof that its backing service is running or that a live acceptance check passed.

Use [local setup](local-setup.md) for development and [deployment tooling](../../../commerce-ops/deploy/ec2/README.md) for identified hosted targets. Current source settings define accepted values; shared docs link to those owners instead of duplicating environment inventories.
