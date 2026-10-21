# Backend agent guide

Read [backend architecture](../../commerce-docs/backend/architecture.md) and
[development checks](../../commerce-docs/backend/development.md) for the affected
domain. Commands below start at the repository root.

## Ownership

- `crates/api-gateway` composes HTTP handlers and workers. Domain behavior belongs
  in its owning `domain-*` crate; infrastructure adapters live in `infra-*`.
- [architecture-policy.json](architecture-policy.json) declares allowed internal
  dependencies. Keep new dependencies consistent with those boundaries.
- Preserve applied migrations in `migrations/` and `engagement-migrations/`.
  Schema changes need a new migration and the relevant upgrade checks.
- Gateway OpenAPI sources live in `crates/api-gateway/openapi/`. Repository
generation commands live in `../../commerce-ops/scripts/contracts/`; frontend API types derive
  from the resulting `openapi.json`.

## Verification

For dependency or module changes:

```sh
python3 commerce-ops/scripts/checks/check-rust-architecture.py
python3 -m unittest discover -s commerce-ops/scripts/tests -p 'test_rust_architecture.py'
```

Run formatting and the affected crate/test first, from `commerce-api/rocento-api/`:

```sh
cargo fmt --all -- --check
cargo test --locked -p <affected-crate> --test <affected-suite>
```

The development guide specifies workspace checks and database/search fixtures.
Database-backed tests require an isolated configured database; a skipped fixture
does not verify persistence. Authentication-heavy suites use `--test-threads=2`.
