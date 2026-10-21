# Durability and Recovery

## Base Durability

The base PostgreSQL container uses a named volume and durable PostgreSQL settings. This protects local data from ordinary container restarts and `docker compose down` without `-v`.

Base settings in `commerce-ops/compose/compose.yaml`:

- `fsync=on`
- `synchronous_commit=on`
- `full_page_writes=on`
- `wal_level=replica`
- `postgres-data` named volume

## Durability Overlay

`commerce-ops/compose/compose.durability.yaml` adds:

- `postgres-standby`
- `postgres-sync`
- `postgres-backup`
- WAL archive volume
- backup volume
- helper scripts under `commerce-ops/deploy/durability`

The overlay is described in `commerce-ops/deploy/durability/README.md`. It is a single-host reference topology.

## Recovery Scripts

Key files:

- `commerce-ops/deploy/durability/primary.sh`
- `commerce-ops/deploy/durability/standby.sh`
- `commerce-ops/deploy/durability/enable-sync.sh`
- `commerce-ops/deploy/durability/backup.sh`
- `commerce-ops/deploy/durability/restore.sh`
- `commerce-ops/deploy/durability/archive-wal.sh`
- `commerce-ops/deploy/durability/schedule-backups.sh`
- `commerce-ops/deploy/durability/backup-health.sh`

## Verification Scripts

- `commerce-ops/scripts/m14-durability.py`
- `commerce-ops/scripts/m14-recovery.py`
- `commerce-ops/scripts/m14-shutdown.py`
- `commerce-ops/scripts/m14-checkout.py`
- `commerce-ops/scripts/m14-unit.py`
