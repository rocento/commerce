# AI service agent guide

Start with [AI architecture](../commerce-docs/ai-service/architecture.md),
[local development](../commerce-docs/ai-service/local-development.md) and the
guide for the engine being changed. Python and the Node language engine have
separate dependency environments.

## Ownership

- `app/commerce_action_engine` owns action contracts, deterministic execution,
  application handlers and adapters. Keep deterministic core code independent
  of HTTP, database, model providers and application orchestration.
- `app/commerce_orchestration_engine` coordinates journeys;
  `app/commerce_resolution_engine` owns resolution and provider integration;
  `app/commerce_knowledge_rag` owns knowledge retrieval.
- `app/commerce_language_engine` is a separate Node runtime. Use its own
  `package.json` commands and [release procedure](../commerce-docs/ai-service/language-release-upgrade.md).
- Preserve delegated authority: Rust owns commerce facts and mutations.
  Generated contracts and capability documentation must come from their owners.
- Evaluation fixtures, release bundles and knowledge packs are runtime or
  verification inputs; a historical name alone does not make them disposable.

## Verification

For Python boundary changes, run from the repository root:

```sh
python3 commerce-ops/scripts/checks/check-ai-architecture.py
python3 -m unittest discover -s commerce-ops/scripts/tests -p test_ai_architecture.py
commerce-assistant-platform/.venv/bin/python commerce-ops/scripts/generation/generate_ai_capabilities.py --check
```

Run focused `tests/` suites from `commerce-assistant-platform/` with `.venv/bin/python -m pytest`.
The local development guide lists checks for the changed behavior and broader
Ruff, mypy and pytest validation.

For language changes, run `npm test`, `npm run typecheck` and
`npm run verify:artifacts` from `commerce-assistant-platform/app/commerce_language_engine/`. Inspect fixture
requirements first; release/database checks require their declared environment.
