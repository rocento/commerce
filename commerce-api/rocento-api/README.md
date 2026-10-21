# Commerce API

This directory is the Rust workspace for Rocento's API gateway, commerce domain
crates, persistence migrations and generated API contracts. The main service is
built from this directory by [`compose.yaml`](../../commerce-ops/compose/compose.yaml).

## Start here

- [Backend architecture](../../commerce-docs/backend/architecture.md)
- [Development and local checks](../../commerce-docs/backend/development.md)
- [API contract inventory](../../commerce-docs/backend/api-inventory.md)
- [Local Compose setup](../../commerce-docs/platform/operations/local-setup.md)

Run Cargo commands from this directory. Keep domain behavior in its owning
`domain-*` crate, HTTP composition in `crates/api-gateway`, and schema changes in
`migrations/` or `engagement-migrations/` as appropriate.
