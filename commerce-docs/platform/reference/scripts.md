# Repository command reference

Use this guide to find the canonical implementation of a repository command.
Commands run from the repository root unless the owning guide says otherwise.
[Agent instructions](../../../commerce-ops/scripts/AGENTS.md) cover changes to commands and
their compatibility entry points.

## Find the implementation

| Folder | Responsibility |
| --- | --- |
| `commerce-ops/scripts/local/` | Local setup, Compose launchers and preview helpers |
| `commerce-ops/scripts/contracts/` | Contract generators, adapters and interface/theme synchronization |
| `commerce-ops/scripts/generation/` | Capability documentation, brand assets and image optimization |
| `commerce-ops/scripts/checks/` | Documentation, architecture, migration and smoke checks |
| `commerce-ops/scripts/evaluation/` | Assistant evaluations and performance runs |
| `commerce-ops/scripts/release/` | Preflight, release images, reliability and durability checks |
| `commerce-ops/scripts/demo/` | Reusable seeds, catalog helpers and demo previews |
| `commerce-ops/scripts/demo/history/` | Retained dated catalog operations |
| `commerce-ops/scripts/maintenance/` | Output inventory, cleanup, repair and maintenance SQL |
| `commerce-ops/scripts/tests/` | Command and deployment regression tests |

[The entry-point manifest](../../../commerce-ops/scripts/entrypoints.json) maps retained root
commands to their implementations. Old commands still forward arguments, exit
codes and Python imports; edit the grouped owner. Moved SQL/JSON inputs use their
new paths, listed separately in the manifest. New commands belong in their
purpose folder.

Existing `commerce-ops/scripts/knowledge-baseline/`, `commerce-ops/scripts/shopping_eval/`
and `commerce-ops/scripts/recommendation_eval/` keep their focused tools and
fixtures. There is no staging-server command folder here. Application-owned
scripts remain with their service.

## Release readiness

`python3 commerce-ops/scripts/release/release_readiness.py --help` exposes the candidate-bound
evidence gate. See [release readiness](../operations/release-readiness.md) for
required checks, packet metadata, review and promotion boundaries.

## Contract generation

Canonical generators live in `commerce-ops/scripts/contracts/`. The original
`commerce-ops/scripts/generate_*.py` paths forward to the same implementations, preserving
existing command and import callers. Use the AI virtual environment where a
generator imports Python service models.

| Generator | Owning source or generated destination |
| --- | --- |
| `generate_openapi.py` | Gateway sources in `commerce-api/rocento-api/crates/api-gateway/openapi/`; emits `commerce-api/rocento-api/openapi.json` |
| `generate_public_openapi.py` | Public API documentation projection |
| `generate_merchant_openapi.py` | Merchant API documentation projection |
| `generate_core_contracts.py` | Commerce core wire schemas and fixtures in `commerce-api/rocento-api/crates/commerce-core-contracts/contract/v1/` |
| `generate_meaning_contracts.py` | Commerce meaning wire schemas and fixtures in `commerce-assistant-platform/contracts/commerce-meaning/v1/` |
| `generate_planning_contracts.py` | Commerce planning wire schemas and fixtures in `commerce-assistant-platform/contracts/commerce-planning/v1/` |
| `generate_catalog_tool_contract.py` | Assistant catalog-tool contract |
| `generate_assistant_models.py` | Python assistant models derived from the gateway contract |
| `generate_assistant_validator.py` | Frontend assistant validation schemas |
| `generate_comparison_operators.py` | Shared comparison-operator contract |
| `generate_language_resolution_contract.py` | Language-resolution wire contract in `commerce-assistant-platform/contracts/language-resolution/v2/` and Node generated files |

For generators supporting drift checks:

```sh
commerce-assistant-platform/.venv/bin/python commerce-ops/scripts/contracts/generate_core_contracts.py --check
commerce-assistant-platform/.venv/bin/python commerce-ops/scripts/contracts/generate_meaning_contracts.py --check
commerce-assistant-platform/.venv/bin/python commerce-ops/scripts/contracts/generate_planning_contracts.py --check
commerce-assistant-platform/.venv/bin/python commerce-ops/scripts/contracts/generate_language_resolution_contract.py --check
```

Generators without `--check` write their outputs. Use an isolated fixture for
comparison when the working tree has unrelated generated changes. The release
preflight checks its selected generators in a temporary tree:

```sh
commerce-assistant-platform/.venv/bin/python commerce-ops/scripts/release/agentic-preflight.py
```

`commerce-ops/scripts/generation/generate_ai_capabilities.py` is the source-derived capability and
documentation generator. Native contract generation remains with `commerce-mobile-apps/tools/`.

## Deployment and native preview

| Canonical location | Responsibility | Compatible entry points |
| --- | --- | --- |
| `commerce-ops/deploy/aws-deploy/` | Workstation launchers | `commerce-ops/deploy/aws-deploy/` commands |
| `commerce-ops/deploy/ec2/server/` | Server deployment, verification, source activation and seeding | `commerce-ops/deploy/ec2/server/ec2-*` commands |
| `commerce-ops/deploy/aws-automation/` | Android preview lifecycle controller, installer and tests | `commerce-ops/deploy/aws-automation/` commands |

Read [the workstation deployment guide](../../../commerce-ops/deploy/aws-deploy/README.md),
[EC2 operations](../../../commerce-ops/deploy/ec2/README.md) or
[native controller operations](../../../commerce-ops/deploy/aws-automation/README.md)
before running commands with external effects. Private workstation settings and
keys remain in their existing protected locations; source reorganization does
not move credentials or installed server paths.

## Local setup and demo data

- `commerce-ops/scripts/local/local-compose.sh`: shared local stack entry point; see [local setup](../operations/local-setup.md).
- `commerce-ops/scripts/local/local-assistant-setup.py`: local assistant storage/configuration setup.
- `commerce-ops/scripts/local/bootstrap-admin.py`: create the first local administrator.
- `commerce-ops/scripts/local/assistant-setup.py`: assistant key/secret setup.
- `commerce-ops/scripts/demo/seed-catalog.py`, `commerce-ops/scripts/demo/seed-inventory.py`, `commerce-ops/scripts/demo/seed-reporting.py`: reusable demo seed commands.

Inspect the selected command's environment and side effects before applying
seeds. Dated catalog operations are historical task-specific commands; their
filenames alone do not establish whether an operational caller still needs them.

## Verification and evaluation

- `commerce-ops/scripts/checks/check-documentation.py`: links, anchors, owning indexes, agent instructions and evidence metadata. `--check-local-evidence` verifies hashes for entries still marked locally available.
- `commerce-ops/scripts/checks/check-rust-architecture.py`, `commerce-ops/scripts/checks/check-ai-architecture.py`: service dependency and module boundaries.
- `commerce-ops/scripts/maintenance/inventory-outputs.py`: read-only metadata inventory of retained output locations; it does not choose deletion candidates.
- `commerce-ops/scripts/maintenance/new-output-run.py PURPOSE`: creates `commerce-output/YYYY-MM-DD-purpose/` with a starter manifest and separate evidence, deliverables and work folders. Fill in the candidate and verification fields for each run.
- `commerce-ops/scripts/checks/smoke.py`, `commerce-ops/scripts/checks/assistant-smoke.py`, `commerce-ops/scripts/checks/m1-smoke.py` through the retained milestone commands: environment-specific smoke checks.
- `commerce-ops/scripts/evaluation/agent-evals.py`, `commerce-ops/scripts/evaluation/shopping-evals.py`, `commerce-ops/scripts/evaluation/meaning-evals.py`, `commerce-ops/scripts/evaluation/planning-evals.py`: assistant evaluation entry points.
- `commerce-ops/scripts/release/m14-checkout.py`, `commerce-ops/scripts/release/m14-durability.py`, `commerce-ops/scripts/release/m14-recovery.py`, `commerce-ops/scripts/release/m14-shutdown.py`, `commerce-ops/scripts/release/m14-unit.py`: durability and recovery checks.

Service guides identify focused suites and their fixtures. Command regression
tests live in `commerce-ops/scripts/tests/`; run only the relevant tests first. New run output
uses the [manifest and retention convention](workspace-cleanup.md#retained-evidence).

Run `python3 -m unittest discover -s commerce-ops/scripts/tests -p test_script_layout.py` to check compatibility
commands, local Compose routing, stdin payloads and source fingerprints without
starting services. Deployment uploads must include grouped implementations as
well as wrappers. For commands piped into a container or SSH session, send the
canonical source directly; the receiving environment does not have the wrapper's
checkout paths. Local Compose keeps the `commerce-ai` project name and its
existing volumes.
