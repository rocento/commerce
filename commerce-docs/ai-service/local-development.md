# Local development and validation

Python requires 3.12 or newer. Node requires 22.18 or newer for the language engine. Run these commands from the repository root unless a block changes directory.

```sh
cd commerce-assistant-platform
python3 -m venv .venv
.venv/bin/pip install '.[dev]'
.venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
```

In another terminal:

```sh
cd commerce-assistant-platform/app/commerce_language_engine
npm ci
PORT=3187 npm run dev
```

Set `AI_LANGUAGE_ENGINE_URL` to the reachable Node address when starting Python. Python is disabled until both tenant identity and the verification-key file are configured. Starting both processes does not supply customer authentication, delegated commerce capabilities or an AI database. See [configuration](configuration.md). For the full local infrastructure, follow [platform local setup](../platform/operations/local-setup.md) and the repository Compose configuration.

The development watcher above runs the local parser artifact for iteration. `npm start` and container startup instead verify the migrated database, active release and pinned bundle before serving; prepare that environment using the [release runbook](language-release-upgrade.md).

Node defaults to `127.0.0.1:3000` when no `HOST`/`PORT` override is provided. Its inspector is served at `/`. Runtime loading uses `data/compiled.json` when present, with an in-memory expanded dictionary fallback only when that file is absent. Invalid existing artifacts fail startup.

## Checks


From the repository root:

```sh
python3 commerce-ops/scripts/checks/check-ai-architecture.py
python3 -m unittest discover -s commerce-ops/scripts/tests -p test_ai_architecture.py
commerce-assistant-platform/.venv/bin/python commerce-ops/scripts/generation/generate_ai_capabilities.py --check
commerce-assistant-platform/.venv/bin/python -m pytest commerce-assistant-platform/tests/test_intent_dispatch.py commerce-assistant-platform/tests/test_reasoning_admission.py commerce-assistant-platform/tests/test_live_interpretation.py commerce-assistant-platform/tests/test_compound_admission.py -q
```

For shopping stages and turn persistence, run the boundary tests together with continuation coverage:

```sh
cd commerce-assistant-platform
.venv/bin/python -m pytest tests/test_shopping_stages.py tests/test_shopping_continuation.py tests/test_turn_persistence.py tests/test_shopping.py tests/test_shopping_clarification_sse.py tests/test_active_shopping.py tests/test_compound_execution.py -q
```

For compound coordination, run the focused port tests together with HTTP clarification, plan recovery and execution coverage:

```sh
cd commerce-assistant-platform
.venv/bin/python -m pytest tests/test_compound_coordinator.py tests/test_compound_clarification.py tests/test_compound_plan_chat.py tests/test_compound_orchestration.py tests/test_compound_execution.py -q
```

For wishlist transfer outcomes, partial completion and stream cancellation:

```sh
cd commerce-assistant-platform
.venv/bin/python -m pytest tests/test_wishlist_transfer_domain.py tests/test_wishlist_transfer.py tests/test_interpreted_wishlist_transfer.py -q
```

For wishlist saves, cart-to-wishlist transfers and the shared cart admission policy:

```sh
cd commerce-assistant-platform
.venv/bin/python -m pytest tests/test_cart_to_wishlist.py tests/test_cart_actions.py tests/test_interpreted_cart_actions.py tests/test_cart_handler.py tests/test_product_references.py tests/test_intent_dispatch.py -q
```

For wishlist removal, bounded clearing, partial failures, access and cancellation:

```sh
cd commerce-assistant-platform
.venv/bin/python -m pytest tests/test_wishlist_removal.py tests/test_product_references.py tests/test_customer_support_routes.py tests/test_wishlist_read_direct.py tests/test_standard_product_presentation.py tests/test_denied.py -q
```

For broader Python validation:

```sh
cd commerce-assistant-platform
.venv/bin/ruff check .
.venv/bin/ruff format --check .
.venv/bin/mypy app
.venv/bin/python -m pytest
```

Language validation:

```sh
cd commerce-assistant-platform/app/commerce_language_engine
npm test
npm run typecheck
npm run export:release
```

For the 1,000 wishlist location/access/content questions and direct response boundary:

```sh
node commerce-assistant-platform/evals/wishlist-read/generate.mjs
node commerce-assistant-platform/evals/wishlist-read/evaluate.mjs
commerce-assistant-platform/.venv/bin/python -m pytest commerce-assistant-platform/tests/test_wishlist_read_direct.py -q
```

Run these from the repository root. The generator writes the corpus to `commerce-assistant-platform/evals/wishlist-read/cases.json`. The evaluation checks both the generated vocabulary and packaged runtime; the Python tests use actual Node interpretations with scoped, mocked commerce reads and a model provider that fails if called.

`export:release` verifies the packaged immutable dictionary, archived corpus and parser identity without modifying them. `verify:commerce-artifacts` instead checks the authoring generation report against a compiled dictionary; run it against an isolated matching offline generation, as CI does. Authoring files can differ from the reviewed packaged release and must not be regenerated over it merely to make that check pass.

Use `npm run test:integration` only with the required backing services. Package scripts also expose `evaluate`, `evaluate:understanding`, `evaluate:orders`, `evaluate:coverage`, `evaluate:requests`, `evaluate:transfers` and `benchmark`. Inspect [package.json](../../commerce-assistant-platform/app/commerce_language_engine/package.json) and the relevant script before running corpus or database operations. `migrate`, vocabulary enrichment, generation and release activation can change data; they are not read-only validation.

Pin corpus and dictionary versions when comparing language quality. Record the candidate revision, runtime version, artifact fingerprint, environment and exact results. Unit tests and synthetic evaluations do not establish live customer completion. PostgreSQL concurrency, browser behavior, provider connectivity and gateway delegation require their own integration checks.
