# PostgreSQL durability reference topology

Use the [durability runbook](../../../commerce-docs/platform/operations/durability.md) for prerequisites, fresh and
existing-database setup, backup scheduling, fresh-volume restore, fencing and promotion.
Historical M14 implementation evidence is absent from this checkout. See
[verification guidance](../../../commerce-docs/platform/operations/testing.md#release-evidence) for remaining deployment checks. Do not apply the overlay to an existing stack without
preserving its volumes, all active overlays and a verified backup.
