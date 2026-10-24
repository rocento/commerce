# Development tools

| Owner | Responsibility |
| --- | --- |
| [Checks](checks/README.md) | Repository policy, architecture and targeted integration checks |
| [Contracts](contracts/README.md) | Cross-service generation and synchronization; source contracts stay with their applications |
| [Evaluation](evaluation/README.md) | Assistant behavior and performance commands, with `shopping_eval` and `recommendation_eval` support packages |
| [Generation](generation/README.md) | Capability documentation and brand/image assets |

Run commands from the repository root and use `--check` when supported.
Generators without a check mode should run in a scratch fixture when verifying
layout changes. Some integration checks write data: use the documented target.
Operations regressions live in [tests/operations](../tests/operations/README.md).
The [command inventory](../config/entrypoints.json) names canonical entry points.

Old paths under `scripts/` are compatibility symlinks. Managed uploads use the
canonical tools required by release validation and exclude test suites. Evaluation
artifacts remain with their existing application and QA owners.
