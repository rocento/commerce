# Legacy script paths and historical harnesses

This directory retains historical evidence tooling. Redundant source aliases
have been removed.
New command implementations belong under `local/`, `cloud/`, `services/`,
`workflows/` or `tools/`. Start with the [task menu](../README.md#start-by-task)
and [command interface](../COMMANDS.md) for current operations.

## Retained contents

| Contents | Purpose |
| --- | --- |
| [knowledge-baseline/](knowledge-baseline/README.md) | Retained historical source with original evidence dependencies |

## Ownership and changes

Register public routes in [commands.json](../commands.json) and canonical
executable/data paths in [config/entrypoints.json](../config/entrypoints.json).
Update callers, CI, upload lists and the owning guide together. See
[AGENTS.md](AGENTS.md) for editing and verification rules.

Preserve historical
harness bytes and evidence; use `tools/evaluation/` for new evaluations.
For local assistant preparation, follow [local platform ownership](../local/platform/README.md)
and its linked setup procedure.
