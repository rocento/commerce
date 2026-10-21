# Rocento onboarding API

Standalone Rust service for customer accounts, server-synced onboarding drafts, and temporary domain reservations. It is maintained separately from the customer and staff interfaces in [`../../commerce-web/apps/onboarding`](../../commerce-web/apps/onboarding) and [`../../commerce-web/apps/onboarding-ops`](../../commerce-web/apps/onboarding-ops). See the [onboarding guide](../../commerce-docs/onboarding/README.md) for the complete project layout.

The Rust crate is at this module's root. Routes, account security, draft and reservation logic, database setup, mail delivery, and domain rules are kept in separate files under `src/`. PostgreSQL schema and seed data live under `database/`.

## Local development

Requires Rust/Cargo and Docker. From this folder:

```sh
cp .env.example .env
# Set AUTH_MAIL_KEY in .env to a fresh 64-character hex value from: openssl rand -hex 32
docker compose -f ../../commerce-ops/onboarding/compose.yaml up -d
cargo run --locked --bin migrate
docker compose -f ../../commerce-ops/onboarding/compose.yaml exec -T postgres psql -U rocento -d rocento < database/local-seed.sql
cargo run --locked
```

The API listens at http://127.0.0.1:4100. Health is available at `/api/v1/health`. Customer sessions are held in an HttpOnly, same-origin cookie by the onboarding web app; the app's server-side proxy forwards account and draft requests. Local file mail is development-only.

For local customer fixture calls, set `LOCAL_AUTH_ENABLED=true` and a random `LOCAL_CUSTOMER_TOKEN` of at least 32 characters in `.env`, then restart the API. The fixture is rejected in production. Never commit local secrets or use these settings in a production environment.

The browser-local onboarding preview works without this service. Payment, approved theme releases, staff operations, DNS changes, and store provisioning are not enabled by this module.

## Contracts and implementation notes

- [Implemented API contracts](docs/api-contracts.md)
- [Inventory and implementation plan](docs/implementation-plan.md)
- [Verification history](docs/verification.md)

Build the Rust service with `cargo build --locked`. Database migrations use a Rust binary in this crate, so API and migration tooling share the Cargo lockfile.
