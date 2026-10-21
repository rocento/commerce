# Frontend development and checks

Use Node 22 and the workspace-pinned pnpm 10.32.1. From the repository root:

```sh
cd commerce-web
pnpm install --frozen-lockfile
pnpm dev:storefront
```

Start `pnpm dev:admin` in a second terminal. Storefront binds port 5173 and admin port 5174, both with strict port selection and `/health` liveness handlers. They proxy `/api` to `http://localhost:8080`; `API_PROXY_TARGET` and `API_PROXY_ORIGIN` configure that development proxy. The corporate website uses `pnpm dev:website` on 127.0.0.1:5180.

The customer onboarding app and locked staff shell live in `apps/onboarding/` and `apps/onboarding-ops/`. Start them with `pnpm dev:onboarding` (127.0.0.1:3100) and `pnpm dev:onboarding-ops` (127.0.0.1:3101). The separate Rust API and database live in `commerce-api/onboard-api/`; see the [onboarding guide](../onboarding/README.md). Use `pnpm typecheck:onboarding`, `pnpm build:onboarding`, and `pnpm test:onboarding` for targeted checks.

A running UI does not supply the database, authenticated users, stock or media services. Use [platform local setup](../platform/operations/local-setup.md) for the full stack and [backend setup](../backend/development.md) for its environment.

## Validation commands

Run from `commerce-web`:

```sh
pnpm lint
pnpm typecheck
pnpm typecheck:e2e
pnpm test
pnpm build
```

For targeted work use `pnpm --filter @commerce/storefront typecheck`, `pnpm --filter @commerce/admin typecheck` or `pnpm --filter @rocento/website typecheck`, and pass relevant test filenames to Vitest. `pnpm generate:api` regenerates `packages/api-client/src/schema.d.ts` from `commerce-api/rocento-api/openapi.json`.

Browser suites include `test:admin`, `test:admin:regression`, `test:storefront:smoke`, `test:grids`, `test:themes`, `test:theme-editor`, `test:improvements`, `test:search` and `test:navigation`. Inspect each [Playwright configuration](../../commerce-web) for its service, login, fixture and database requirements before running it. The default admin suite authenticates through global setup, uses `ADMIN_BASE_URL` or 127.0.0.1:5174, and keeps traces/screenshots on failure. The storefront smoke suite uses mocked APIs and starts an isolated Vite server on port 5293; `STOREFRONT_SMOKE_PORT` changes that port. Some theme/editor tests use mocks; other suites operate against a real backend. Their results have different scopes. Retired Quality deployment scripts and the Quality live-browser runner have been removed.

Public renderer checks are local Node scripts under `apps/storefront/server`, including publication, URL policy, metadata, structured data, hardening, health, compression and PWA checks. Run `node` with the corresponding `*-checks.mjs` filename. Browser publication fixtures and deployment gates remain under [publication harnesses](../platform/seo-geo/Tests); their old Markdown guides were replaced by [publication](publication.md).

Check documentation destinations from the repository root with `python3 commerce-ops/scripts/checks/check-documentation.py`. It covers the consolidated service sections and shared `commerce-docs/platform`.

## Cleanup and maintenance

The 2 October cleanup removed the unused shared `Foundation.tsx` starter, its export, the obsolete storefront `theme-default.png`, and three unused admin journey PNG copies. The storefront uses its WebP variants; original jewelry demo images remain under `commerce-assets/demo/jewelry`. Unused starter CSS and assistant header rules were also removed. Generated API contracts, SSR entry points, fonts, licenses, PWA assets and public delivery data remain required.

Browser TypeScript validation covers every `e2e/**/*.ts` suite and every Playwright configuration through `pnpm typecheck:e2e`; CI runs this alongside application typechecking. The older `typecheck:admin-tests` command remains compatible. Dependency build scripts use the pinned pnpm policy in `pnpm-workspace.yaml`, with esbuild allowed.

Category sections share one `GET /v1/catalog/category-availability` request per delivery context. The backend counts all categories before the frontend ranks them and applies section display limits. Query keys include delivery context and category IDs, responses stay fresh for 30 seconds, and requests use the query cancellation signal. Direct search providers batch up to 100 zero-hit searches per request; delegated search providers preserve their existing search contract with four concurrent requests. See [catalog behavior](../backend/catalog-and-markets.md) for count and stock semantics.

Keep public brand images unless their configured theme URLs and `commerce-ops/scripts/generation/sync-brand-assets.py` are updated together. Before consolidating Playwright configurations, preserve each suite's fixture, authentication, port and backend requirements. Shared typography still has global element selectors; further scoping should be paired with visual checks across admin, storefront and public rendering.

Keep cleanup validation records tied to the exact candidate and environment. Mocked browser results do not establish live backend or production acceptance.
