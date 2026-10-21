# Repository command guide for agents

Use the [script reference](../../commerce-docs/platform/reference/scripts.md) to
find a command's purpose and the [repository map](../../commerce-docs/platform/reference/repository-map.md)
to find its service owner. Commands normally start at the repository root.

## Canonical implementations

- `contracts/` owns contract/OpenAPI generation, contract adapters and shared
  interface/theme synchronization.
- `generation/` owns capability documentation, brand assets and image generation.
- `local/` owns workstation setup, Compose launchers and local preview helpers.
- `checks/` owns documentation, architecture, migration and smoke checks.
- `evaluation/` owns assistant evaluation and performance entry points.
- `release/` owns preflight, release images, reliability and durability commands.
- `demo/` owns reusable seeds, catalog helpers and storefront previews;
  `demo/history/` retains dated catalog operations.
- `maintenance/` owns inventory, cleanup, repair and maintenance SQL.
- EC2 workstation launchers live in `../deploy/aws-deploy/`; server commands live
  in `../deploy/ec2/server/`. Call server commands directly; no `ec2-*` wrappers remain here.
- `knowledge-baseline/`, `shopping_eval/`, `recommendation_eval/` and `staging/`
  retain their existing focused tools and fixtures.
- [entrypoints.json](entrypoints.json) maps old command paths to their canonical
  owners and records moved data files. Root commands are compatibility wrappers.
  Add new commands to their purpose folder; do not create more root wrappers
  unless an existing caller needs one.
- `tests/` contains command and deployment regression tests. Service tests remain
  with their owning service.

## Changes and verification

Edit the canonical implementation rather than adding logic to forwarding files.
Preserve CLI arguments, exit codes and any imported functions used by callers.
When moving code, inspect `__file__` root discovery, sibling imports, `runpy` or
`importlib` loaders, scratch-copy fixtures and explicit deployment file lists.
Commands streamed through stdin must send the canonical source and must not
depend on checkout-relative imports. Ship canonical owners alongside wrappers
in partial uploads. Include both in any source fingerprint that covers them.

Run focused tests from the repository root:

```sh
python3 -m unittest discover -s commerce-ops/scripts/tests -p '<affected-test-file>.py'
python3 -m unittest discover -s commerce-ops/scripts/tests -p 'test_script_layout.py'
```

Use `commerce-assistant-platform/.venv/bin/python` for generators that need the AI dependencies.
Prefer a generator's `--check` mode; use an isolated fixture when generation
would otherwise overwrite unrelated working changes. Validate shell syntax with
`bash -n` and exercise path/argument forwarding in the corresponding tests.
