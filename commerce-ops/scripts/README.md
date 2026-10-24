# Operations commands

Compatibility boundary: do not add new command implementations here. Use the
canonical `local/`, `cloud/`, `services/`, `workflows/` or `tools/` owner.
Retained historical harnesses, installed adapters and deployment assets keep
their documented ownership until their consumers migrate.

Run commands from the repository root. Start with a [task guide](../README.md#start-by-task)
for a complete workflow, or use the [command reference](../../commerce-docs/platform/reference/scripts.md)
to find a specific command.

| Folder | Purpose |
| --- | --- |
| [`../local/`](../local/README.md) | Local stack startup, credentials, storage initialization, onboarding dependencies, and preview helpers |
| [`local/`](local/README.md) | Compatibility links for workstation and service helpers |
| [`../tools/checks/`](../tools/checks/README.md) | Architecture, documentation, migration, and integration checks |
| [`../tools/contracts/`](../tools/contracts/README.md) | API and shared contract generation and synchronization |
| [`../tools/generation/`](../tools/generation/README.md) | Capability documentation, brand assets, and image preparation |
| [`../tools/evaluation/`](../tools/evaluation/README.md) | Assistant evaluation and performance commands |
| [`../workflows/release/`](../workflows/release/README.md) | Candidate artifacts, release gates, and transaction qualification |
| [`../workflows/demo/`](../workflows/demo/README.md) | Demo catalog seeds, storefront configuration, and previews |
| [`../workflows/maintenance/`](../workflows/maintenance/README.md) | Inventory, cleanup, repair, and database maintenance |
| [`../tests/operations/`](../tests/operations/README.md) | Command and deployment regression tests |

[Shopping support](../tools/shopping_eval/README.md),
[recommendation evaluation](../tools/recommendation_eval/README.md), and
[knowledge evidence tools](knowledge-baseline/README.md) have their own guides.

## Local assistant setup

- `python3 commerce-ops/local/platform/create-assistant-credentials.py` creates missing local credentials.
- `python3 commerce-ops/local/platform/initialize-assistant-storage.py` creates credentials as needed, initializes storage, applies migrations, and writes local runtime configuration.

Follow the [local setup guide](../../commerce-docs/platform/operations/local-setup.md)
for required images and service startup order.

## Adding or moving commands

Keep each implementation in its purpose folder and register public commands in
`entrypoints.json`. Update callers, CI, upload lists, and documentation in the
same change. Python entry scripts may delegate to importable modules; shared
logic belongs in those modules. Read [AGENTS.md](AGENTS.md) for editing and
verification instructions.
