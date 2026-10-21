# DBeaver database access

Connect to the shared AI databases for inspection. The current local topology is defined by [local setup](../platform/operations/local-setup.md#assistant-and-optional-services), [compose.local.yaml](../../commerce-ops/compose/compose.local.yaml) and [the initializer](../../commerce-ops/scripts/local/local-assistant-setup.py). Both `assistant` and `commerce_language` use the local `ai-postgres` service. Production also keeps these two databases together; commerce databases remain separate.

Reviewed against source on 2026-10-14. The earlier production connection check was recorded on 2026-10-09; these instructions do not certify that a host or password is unchanged.

## Connection settings

Initialize and start the local assistant through the owning [local setup guide](../platform/operations/local-setup.md#assistant-and-optional-services) first. Local port `15432` is available only after enabling the optional DBeaver overlay below.

Create PostgreSQL connections using these Main-tab values:

| Connection | Host | Port | Database | Username | SSH |
| --- | --- | --- | --- | --- | --- |
| Local — language | `127.0.0.1` | `15432` | `commerce_language` | `ai_owner` | Off |
| Local — assistant | `127.0.0.1` | `15432` | `assistant` | `ai_owner` | Off |
| Production — shared language | `127.0.0.1` | `15432` | `commerce_language` | `ai_owner` | On |
| Production — shared assistant | `127.0.0.1` | `15432` | `assistant` | `ai_owner` | On |

Local port `5432` belongs to commerce PostgreSQL. A retained legacy language database there is not the runtime language database after shared local initialization. Do not remove it or move data merely to make a saved connection match this guide.

For production, DBeaver reaches the Main-tab host **from the SSH server**. Enable **Use SSH Tunnel**, then use the deployment's current SSH host, port, user and private key. Use placeholders such as `<production-host>`, `<ssh-user>` and `<private-key-path>` when sharing connection instructions. Leave DBeaver's local tunnel port automatic; no separate terminal tunnel is required. See the [DBeaver SSH configuration guide](https://github.com/dbeaver/dbeaver/wiki/SSH-Configuration).

Retired per-demo AI container IPs and commerce ports are not shared production AI targets. Check the connection before replacing an old saved configuration. The listed owner accounts can modify data; use a read-only DBeaver connection for inspection and the release workflow for published language changes.

## Protected credentials

The same local owner password serves both AI databases and comes from `.local/assistant/store-admin-password`. It is separate from `.env`'s commerce password. Runtime accounts use their own restricted identities and passwords; DBeaver owner access must not be copied into runtime configuration.

From the repository root, macOS users can copy the local password without printing it:

```sh
pbcopy < .local/assistant/store-admin-password
```

Production credentials stay on the deployment host. After setting `AI_DB_SSH_KEY`, `AI_DB_SSH_USER` and `AI_DB_SSH_HOST` to the intended deployment, the following copies the shared owner password to the macOS clipboard:

```sh
ssh -i "$AI_DB_SSH_KEY" -o StrictHostKeyChecking=yes \
  "$AI_DB_SSH_USER@$AI_DB_SSH_HOST" \
  'sudo -n cat /opt/rocento/deploy/ec2/shared-ai/admin-password' \
  | tr -d '\r\n' | pbcopy
```

`/opt/rocento/deploy/ec2/shared-ai/admin-password` is a protected path on the production host. On other operating systems use the approved local credential workflow; do not print secrets into logs or save them in documentation.

## Enable the local inspection port

The [DBeaver overlay](../../commerce-ops/compose/compose.assistant-dbeaver.yaml) publishes `127.0.0.1:15432` and adds the Docker Desktop bridge while retaining the `ai-data` volume. After the standard local setup has created `commerce-ai-ai-postgres-1`, run from the repository root:

```sh
DBEAVER_AI_POSTGRES_IMAGE="$(docker inspect --format '{{.Config.Image}}' commerce-ai-ai-postgres-1)" \
  bash commerce-ops/scripts/local/local-compose.sh --assistant -f commerce-ops/compose/compose.assistant-dbeaver.yaml \
  up -d --no-deps --no-build --pull never ai-postgres
```

This explicitly reuses the existing local database image. Retain the DBeaver overlay and selected image when recreating that service if inspection access is still needed. Normal application startup and migrations remain owned by [local setup](../platform/operations/local-setup.md). Production uses [compose.ai-shared.yaml](../../commerce-ops/compose/compose.ai-shared.yaml) with SSH access.

## Tables to inspect

In `assistant`, inspect the `assistant` schema: `conversations`, `messages`, `turns`, `compound_plans`, `request_revisions`, `tracking_reports`, `knowledge_sources`, and `knowledge_chunks`. Shared production uses `tenant_id` and `tenant_logins`; a freshly initialized single-merchant local database can still use the legacy `deployment` identity. In shared mode that singleton is compatibility metadata, not the tenant registry.

In `commerce_language`, inspect `intent`, `entity`, `context`, `semantic`, `knowledge`, `lexicon`, and `release`. Production `migration_archive` retains operator-only historical differences from the original demo databases. Editing a row alone does not activate or reload a language release.

Confirm the actual connection using this read-only query:

```sql
SELECT current_database(), current_user, inet_server_addr(), inet_server_port();
```

For migrations, backups, permissions and recovery, use [shared database operations](shared-database-operations.md). For language changes, use the [release lifecycle](language-release-upgrade.md).
