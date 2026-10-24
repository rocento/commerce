# Repository command guide for agents

Compatibility boundary: do not add new command implementations here. Use the
canonical `local/`, `cloud/`, `services/`, `workflows/` or `tools/` owner.
Retained historical harnesses, installed adapters and deployment assets keep
their documented ownership until their consumers migrate.

Use the [script reference](../../commerce-docs/platform/reference/scripts.md) to
find a command's purpose and the [repository map](../../commerce-docs/platform/reference/repository-map.md)
to find its service owner. Commands normally start at the repository root.

## Canonical implementations

- `../tools/contracts/` owns contract/OpenAPI generation, contract adapters and shared
  interface/theme synchronization.
- `../tools/generation/` owns capability documentation, brand assets and image generation.
- `../local/` owns workstation setup, Compose launchers, onboarding dependencies,
  and local preview helpers. `local/` retains compatibility links; host helpers belong to `../services/`.
- `../tools/checks/` owns documentation, architecture, migration and smoke checks.
- `../tools/evaluation/` owns assistant evaluation and performance entry points.
- `../workflows/release/` owns preflight, release images, reliability and durability commands.
- `../workflows/demo/` owns reusable seeds, catalog helpers and storefront previews;
  `../workflows/demo/history/` retains dated catalog operations.
- `../workflows/maintenance/` owns inventory, cleanup, repair and maintenance SQL.
- EC2 workstation launchers live in `../cloud/providers/aws/`; server commands live
  in `../deploy/ec2/server/`. Call server commands directly; no `ec2-*` wrappers remain here.
- `knowledge-baseline/` retains phase-bound evidence harnesses; `../tools/shopping_eval/`
  supports the active shopping evaluator; `../tools/recommendation_eval/` owns a separate
  fixed-corpus pipeline. Read each folder README before changing its artifacts.
  There is no `staging/` command folder.
- [entrypoints.json](../config/entrypoints.json) inventories canonical command and data
  paths. Use those paths in code, CI and runbooks. Add new commands to their
  purpose folder; do not add root-level forwarding scripts.
- `../tests/operations/` contains command and deployment regression tests. Service tests remain
  with their owning service.

## Changes and verification

Keep one canonical implementation for each command; don't add duplicate
forwarding commands.
Preserve CLI arguments, exit codes and imported functions used by callers.
When moving code, inspect `__file__` root discovery, sibling imports, `runpy` or
`importlib` loaders, scratch-copy fixtures and explicit deployment file lists.
Commands streamed through stdin must send the canonical source and must not
depend on checkout-relative imports. Partial uploads and source fingerprints
should include canonical owners and their required helper files.

Run focused tests from the repository root:

```sh
python3 -m unittest discover -s commerce-ops/tests/operations -p '<affected-test-file>.py'
python3 -m unittest discover -s commerce-ops/tests/operations -p 'test_script_layout.py'
```

Use `commerce-assistant-platform/.venv/bin/python` for generators that need the AI dependencies.
Prefer a generator's `--check` mode; use an isolated fixture when generation
would otherwise overwrite unrelated working changes. Validate shell syntax with
`bash -n` and exercise path/argument forwarding in the corresponding tests.
