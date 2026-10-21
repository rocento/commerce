# Onboarding local infrastructure

This folder contains the isolated local dependencies for the standalone Rust
onboarding API. It is development infrastructure, not a production onboarding
or merchant provisioning package.

The API crate owns its schema, seed file, and migration binary. Follow the
[API local development guide](../../commerce-api/onboard-api/README.md) and run
commands from `commerce-api/onboard-api/`:

```sh
docker compose -f ../../commerce-ops/onboarding/compose.yaml up -d
cargo run --locked --bin migrate
docker compose -f ../../commerce-ops/onboarding/compose.yaml exec -T postgres psql -U rocento -d rocento < database/local-seed.sql
```

The customer and staff web apps are documented in the
[onboarding project guide](../../commerce-docs/onboarding/README.md). Store
provisioning, payment, DNS, and production customer onboarding are not managed
by this local dependency stack.
