# Repository command reference

Use this guide to find the canonical implementation of a repository command.
Commands run from the repository root unless the owning guide says otherwise.
[Agent instructions](../../../commerce-ops/scripts/AGENTS.md) cover changes to commands and
command ownership and verification.

## Find the implementation

| Folder | Responsibility |
| --- | --- |
| `commerce-ops/local/platform/`, `commerce-ops/local/preview/` | Local setup, Compose launchers and preview helpers |
| `commerce-ops/scripts/local/` | Compatibility links for workstation and service helpers |
| `commerce-ops/tools/contracts/` | Contract generators, adapters and interface/theme synchronization |
| `commerce-ops/tools/generation/` | Capability documentation, brand assets and image optimization |
| `commerce-ops/tools/checks/` | Documentation, architecture, migration and smoke checks |
| `commerce-ops/tools/evaluation/` | Assistant evaluations and performance runs |
| `commerce-ops/workflows/release/` | Preflight, release images, reliability and durability checks |
| `commerce-ops/workflows/demo/` | Reusable seeds, catalog helpers and demo previews |
| `commerce-ops/workflows/demo/history/` | Retained dated catalog operations |
| `commerce-ops/workflows/maintenance/` | Output inventory, cleanup, repair and maintenance SQL |
| `commerce-ops/tests/operations/` | Command and deployment regression tests |

[The command manifest](../../../commerce-ops/config/entrypoints.json) lists canonical
command and data paths. Run commands from their purpose folders; there are no
root-level forwarding scripts. New commands belong in their purpose folder.

`commerce-ops/scripts/knowledge-baseline/` contains phase-bound evidence tools;
`commerce-ops/tools/shopping_eval/` supports the active shopping evaluator;
and `commerce-ops/tools/recommendation_eval/` owns the fixed recommendation
pipeline. Their [folder guides](../../../commerce-ops/scripts/knowledge-baseline/README.md),
[shopping package guide](../../../commerce-ops/tools/shopping_eval/README.md), and
[recommendation pipeline guide](../../../commerce-ops/tools/recommendation_eval/README.md)
explain ownership and retention. There is no staging-server command folder here.
Application-owned scripts remain with their service.

## Release readiness

`python3 commerce-ops/workflows/release/release_readiness.py --help` exposes the candidate-bound
evidence gate. See [release readiness](../operations/release-readiness.md) for
required checks, packet metadata, review and promotion boundaries.

## Contract generation

Canonical generators live in `commerce-ops/tools/contracts/`. Use the AI
virtual environment where a generator imports Python service models.

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
commerce-assistant-platform/.venv/bin/python commerce-ops/tools/contracts/generate_core_contracts.py --check
commerce-assistant-platform/.venv/bin/python commerce-ops/tools/contracts/generate_meaning_contracts.py --check
commerce-assistant-platform/.venv/bin/python commerce-ops/tools/contracts/generate_planning_contracts.py --check
commerce-assistant-platform/.venv/bin/python commerce-ops/tools/contracts/generate_language_resolution_contract.py --check
```

Generators without `--check` write their outputs. Use an isolated fixture for
comparison when the working tree has unrelated generated changes. The release
preflight checks its selected generators in a temporary tree:

```sh
commerce-assistant-platform/.venv/bin/python commerce-ops/workflows/release/agentic-preflight.py
```

`commerce-ops/tools/generation/generate_ai_capabilities.py` is the source-derived capability and
documentation generator. Native contract generation remains with `commerce-mobile-apps/tools/`.

## Deployment and native preview

| Canonical location | Responsibility | Commands |
| --- | --- | --- |
| `commerce-ops/cloud/providers/aws/`, `commerce-ops/cloud/providers/gcp/` | Cloud workstation launchers | `commerce-ops/bin/ops cloud ...` commands |
| `commerce-ops/deploy/ec2/server/` | Server deployment, verification, source activation and seeding | `commerce-ops/deploy/ec2/server/ec2-*` commands |
| `commerce-ops/services/native-preview/aws-controller/` | Android preview lifecycle controller, installer and tests | `commerce-ops/services/native-preview/aws-controller/` commands |

Read [the workstation deployment guide](../../../commerce-ops/cloud/providers/aws/README.md),
[EC2 operations](../../../commerce-ops/deploy/ec2/README.md) or
[native controller operations](../../../commerce-ops/services/native-preview/aws-controller/README.md)
before running commands with external effects. Private workstation targets and
keys live under ignored `.local/commerce-ops/targets/` and `secrets/`; installed
server paths remain unchanged.

## Local setup and demo data

- `commerce-ops/local/platform/local-compose.sh`: shared local stack entry point; see [local setup](../operations/local-setup.md).
- `commerce-ops/local/platform/initialize-assistant-storage.py`: local assistant storage/configuration setup.
- `commerce-ops/local/platform/bootstrap-admin.py`: create the first local administrator.
- `commerce-ops/local/platform/create-assistant-credentials.py`: assistant key/secret setup.
- `commerce-ops/workflows/demo/seed-catalog.py`, `commerce-ops/workflows/demo/seed-inventory.py`, `commerce-ops/workflows/demo/seed-reporting.py`: reusable demo seed commands.

Inspect the selected command's environment and side effects before applying
seeds. Dated catalog operations are historical task-specific commands; their
filenames alone do not establish whether an operational caller still needs them.

## Verification and evaluation

- `commerce-ops/tools/checks/check-documentation.py`: links, anchors, owning indexes, agent instructions and evidence metadata. `--check-local-evidence` verifies hashes for entries still marked locally available.
- `commerce-ops/tools/checks/check-rust-architecture.py`, `commerce-ops/tools/checks/check-ai-architecture.py`: service dependency and module boundaries.
- `commerce-ops/workflows/maintenance/inventory-outputs.py`: read-only metadata inventory of retained output locations; it does not choose deletion candidates.
- `commerce-ops/workflows/maintenance/new-output-run.py PURPOSE`: creates `commerce-output/YYYY-MM-DD-purpose/` with a starter manifest and separate evidence, deliverables and work folders. Fill in the candidate and verification fields for each run.
- The focused local checks use behavior-based names:

  | Command | Purpose |
  | --- | --- |
  | `customer-authentication-smoke.py` | Signup, verification, login, location and logout |
  | `catalog-search-integration.py` | Catalog writes, indexing and search filters |
  | `cart-reservation-regression.py` | Cart ownership and inventory reservation behavior |
  | `cash-on-delivery-replay.py` | COD lifecycle and publisher-crash replay |
  | `checkout-fee-regression.py` | Checkout fee and fulfillment regressions |
  | `promotion-regression.py` | Promotion pricing and checkout behavior |
  | `merchant-operations-regression.py` | Bulk catalog operations, CMS, reviews and wishlist |
  | `reporting-observability-smoke.py` | Reporting accuracy, load and observability |
  | `migration-upgrade-check.py` | Migration and upgrade behavior on disposable PostgreSQL |
  | `catalog-attribute-definition-smoke.py` | Catalog attributes and product types |
  | `split-inventory-area-smoke.py` | Split inventory and delivery-area behavior |
  | `delivery-area-schema-check.py` | Delivery-area schema contract on a disposable database |
  | `delivery-area-search-integration.py` | Delivery-area search integration with Meilisearch |
  | `delivery-and-checkout-regressions.py` | Gateway delivery, inventory and checkout regressions |
- `commerce-ops/workflows/demo/delivery-area-demo.py`: local two-zone delivery-area demo.
- `commerce-ops/tools/evaluation/agent-evals.py`, `commerce-ops/tools/evaluation/shopping-evals.py`, `commerce-ops/tools/evaluation/meaning-evals.py`, `commerce-ops/tools/evaluation/planning-evals.py`: assistant evaluation entry points.
- `commerce-ops/tools/evaluation/discovery-relevance-evals.py`: isolated discovery adapter evaluation.
- `commerce-ops/workflows/release/checkout_reliability.py`: isolated checkout reliability and replay checks.
- `commerce-ops/workflows/release/gateway-shutdown-check.py`: graceful gateway shutdown check.
- `commerce-ops/workflows/release/isolated-db-regression.py`: API database regressions against disposable Postgres.

Service guides identify focused suites and their fixtures. Command regression
tests live in `commerce-ops/tests/operations/`; run only the relevant tests first.
New run output uses the [manifest and retention convention](workspace-cleanup.md#retained-evidence).

Run `python3 -m unittest discover -s commerce-ops/tests/operations -p test_script_layout.py` to check
canonical command paths, local Compose routing, stdin payloads and source
fingerprints without starting services. Deployment uploads must include each
command's implementation and required helper files. For commands piped into a
container or SSH session, send the canonical source directly. Local Compose keeps
the `commerce-ai` project name and its existing volumes.
