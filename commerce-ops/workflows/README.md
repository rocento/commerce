# Operations workflows

These commands prepare releases, seed demo data, and perform maintenance.
Provider access and host lifecycle remain under `cloud/`; local startup stays
under `local/`; development checks, generators and evaluations live under `tools/`.

| Owner | Operator procedure |
| --- | --- |
| [Release](release/README.md) | [Release preparation](../tasks/release-preparation.md) |
| [Demo](demo/README.md) | [Demo seeding](../tasks/demo-seeding.md) |
| [Maintenance](maintenance/README.md) | Inspect each command's target and apply/preview options before writing |

Public commands are registered in [commands.json](../commands.json) and the
[entry-point inventory](../config/entrypoints.json). Canonical modules and
sibling helpers travel together in full or partial uploads. The old source aliases under `scripts/` have been removed. Installed old files remain protected until callers are
audited; new host operations use `workflows/` directly.
