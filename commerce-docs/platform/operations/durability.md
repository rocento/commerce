# Durability and Recovery

## Base Durability

The base PostgreSQL container uses a named volume and durable PostgreSQL settings. This protects local data from ordinary container restarts and `docker compose down` without `-v`.

Base settings in `commerce-ops/compose/base/compose.yaml`:

- `fsync=on`
- `synchronous_commit=on`
- `full_page_writes=on`
- `wal_level=replica`
- `postgres-data` named volume

## Supported scope

The optional backup/restore/standby toolkit, its Compose overlay, and the two
associated storage/recovery drills have been removed from this checkout.
There is no repository-managed backup scheduler or restore command in this scope.
This source change does not uninstall services on existing hosts or remove data.

## Retained qualification commands

- `commerce-ops/workflows/release/gateway-shutdown-check.py`
- `commerce-ops/workflows/release/checkout_reliability.py`
- `commerce-ops/workflows/release/isolated-db-regression.py`

The manual transaction qualification workflow runs database regressions, the
HTTP commerce journey, and graceful shutdown checks. It does not certify
backup restoration or failover.
