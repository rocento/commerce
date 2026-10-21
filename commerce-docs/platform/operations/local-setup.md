# Local setup

Run Compose and Python script commands from the repository root. Install Docker Desktop with Compose 2.24.4 or newer (demo overlays use `!override`), the repository Rust toolchain, Node 22.18 or newer, pnpm 10.32.1, and Python 3.12 or newer.

## Base stack

Start Docker Desktop and wait for `docker info` to succeed. Preserve an existing `.env`:

```sh
[ -f .env ] || cp .env.example .env
bash commerce-ops/scripts/local/local-compose.sh up --build --wait
python3 commerce-ops/scripts/checks/smoke.py
```

| Service | Local address |
| --- | --- |
| Storefront / admin | http://localhost:5173 / http://localhost:5174 |
| Gateway liveness / readiness | http://localhost:8080/health / http://localhost:8080/ready |
| AI diagnostics, with `--assistant --profile diagnostics` | http://localhost:8000/health |
| PostgreSQL | localhost:5432 |
| ClickHouse | http://localhost:8123 |
| NATS / monitoring | localhost:4222 / http://localhost:8222 |
| Meilisearch | http://localhost:7700 |
| MinIO / console | http://localhost:9000 / http://localhost:9001 |

For a new database, `python3 commerce-ops/scripts/bootstrap-admin.py` creates the first administrator and saves local credentials in `.local/admin-credentials.txt`. Use the existing credentials on an initialized installation. Storefront customers register separately through `/register`.

The gateway's `/health` checks liveness; `/ready` checks PostgreSQL/schema readiness and returns 503 in database-free mode. Compose waits on `/ready`. Search, media, analytics and assistant availability need their own checks.

## Assistant and optional services

The base stack contains one Rust API gateway; its analytics, engagement and export workers share the same backend image. AI services are enabled separately. Follow [AI local development](../../ai-service/local-development.md) and [configuration](../../ai-service/configuration.md) for identity, keys, persistence and provider setup. Containerized language startup also requires a migrated database and an explicitly prepared matching release; follow [the language release runbook](../../ai-service/language-release-upgrade.md).

For the single-merchant local stack, build the assistant images and initialize shared AI storage once:

```sh
docker compose -f commerce-ops/compose/compose.yaml -f commerce-ops/compose/compose.assistant.yaml -f commerce-ops/compose/compose.language-engine.yaml build ai-postgres ai-service commerce-language-engine
python3 commerce-ops/scripts/local/local-assistant-setup.py
```

The setup backs up existing assistant data, applies migrations, and initializes an empty language database from the verified packaged release. It keeps existing volumes and never changes an active language release. The language runtime has a restricted tenant login. `commerce-ops/compose/compose.local.yaml` puts both AI databases on the existing AI PostgreSQL service, matching live shared storage within one local merchant installation.

Start the full local stack:

```sh
bash commerce-ops/scripts/local/local-compose.sh --assistant up -d --wait
python3 commerce-ops/scripts/checks/smoke.py --assistant
```

The wrapper uses the admin-managed provider overlay. Custom installations using another provider overlay should retain their explicit Compose command. Add `--build` after code changes. Configure models through **System → AI assistant** in the admin; preserve existing keys when restarting.

Add `-f commerce-ops/compose/compose.notifications.yaml` to the same Compose command for a local Mailpit inbox at http://localhost:8025. Keep that overlay in later commands. Hosted email configuration is documented in [SMTP setup](../../../commerce-ops/deploy/aws-deploy/SMTP.md).

## Independent demo stores

Each demo uses the same application code with separate project volumes and networks. For example:

```sh
docker compose -p commerce-jewelry -f commerce-ops/compose/compose.yaml -f commerce-ops/compose/compose.jewelry.yaml up -d --build --wait
```

| Demo | Project / overlay | Storefront | Admin | Gateway |
| --- | --- | --- | --- | --- |
| Jewelry | `commerce-jewelry` / `commerce-ops/compose/compose.jewelry.yaml` | 5273 | 5274 | 58080 |
| Electronics | `commerce-electronics` / `commerce-ops/compose/compose.electronics.yaml` | 5373 | 5374 | 59080 |
| Pharmacy | `commerce-pharmacy` / `commerce-ops/compose/compose.pharmacy.yaml` | 5473 | 5474 | 60080 |

Ports bind to loopback. Use separate browser profiles for demo admin sessions, or `localhost` for Grocery and `127.0.0.1` for one other demo: cookies are shared across ports on a hostname. These overlays alone do not configure a separate assistant installation.

Normal startup does not require reseeding. Inspect the preset without writes using `python3 commerce-ops/scripts/seed-demo-storefront.py jewelry`. See [assets and demos](../../frontend/assets-and-demos.md) for initialization, explicit `--apply --publish` seeding, inventory and delivery prerequisites. Always use the intended demo's API and administrator credentials.

## Native development and website

Use the owning guides for commands and environment setup:

- [Backend development](../../backend/development.md)
- [Storefront and website development](../../frontend/development.md)
- [Admin development](../../admin-ui/development.md)
- [AI development](../../ai-service/local-development.md)

The corporate website runs separately from Compose. From `commerce-web`, run `pnpm dev:website` for development or `pnpm build:website` to export. Preview an existing export from the repository root:

```sh
python3 -m http.server 5180 --bind 127.0.0.1 --directory commerce-corporate-site/out
```

Run only one server per port. See [website configuration](../../frontend/website.md) for demo links and build inputs.

## Status and shutdown

Use `bash commerce-ops/scripts/local-compose.sh --assistant ps`, `logs --tail 100`, or `stop` for the full stack. Include `--profile diagnostics` to expose the optional AI health proxy on port 8000. `stop` preserves containers and data; `down` removes containers/networks but preserves named volumes. Adding `-v` deletes stored data.

If a page fails to open, inspect the matching project's service status and logs. Rebuild after source changes. Avoid binding native Vite and Compose frontends to the same ports. Assistant readiness failures require checking both language release readiness and Python configuration.
