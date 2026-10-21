# Frontend agent guide

Use [frontend development](../commerce-docs/frontend/development.md) and the
[admin guide](../commerce-docs/admin-ui/README.md) for service-specific checks.
Commands below run from `commerce-web/`, using its pinned pnpm workspace.

## Ownership

- `apps/storefront` owns the customer application and public renderer;
  `apps/admin` owns merchant operations.
- App Studio lives in `apps/mobile-studio/`; rengine lives in `apps/rengine/`.
  The corporate site lives in `commerce-corporate-site/`. Read each project
  guide before editing it.
- Customer onboarding and its locked staff shell live in
  `apps/onboarding/` and `apps/onboarding-staff/`. Its API and database live in
  `../commerce-api/onboard-api/`. Onboarding browser checks live in
  `e2e/onboarding/` and use `playwright.onboarding.config.ts`.
- `packages/api-client` owns shared frontend API access and generated types;
  `packages/ui` owns shared UI resources. Keep app-specific behavior in its app.
- Regenerate `packages/api-client/src/schema.d.ts` with `pnpm generate:api` after
  updating the backend-owned OpenAPI contract.
- Browser suites in `e2e/` have different authentication, ports and backend
  requirements. Read the selected Playwright configuration before running it.

## Verification

Start with the affected package's typecheck and focused Vitest or browser suite.
For changes across the workspace:

```sh
pnpm lint
pnpm typecheck
pnpm typecheck:e2e
pnpm test
```

Public renderer changes also need the corresponding `apps/storefront/server/*-checks.mjs`
checks. UI behavior changes need relevant browser verification. Preserve existing
public asset URLs and use their generator when updating copied brand assets.
