# Onboarding

The onboarding experience is split by responsibility:

- The customer wizard lives in [`commerce-web/apps/onboarding`](../../commerce-web/apps/onboarding/).
- The locked staff shell lives in [`commerce-web/apps/onboarding-ops`](../../commerce-web/apps/onboarding-ops/).
- Browser checks live in [`commerce-web/e2e/onboarding`](../../commerce-web/e2e/onboarding/) and use `playwright.onboarding.config.ts`.
- The standalone Rust API, PostgreSQL schema and local migration tooling live in [`commerce-api/onboard-api`](../../commerce-api/onboard-api/README.md).
- The local PostgreSQL, NATS and registry stack lives in [`commerce-ops/onboarding`](../../commerce-ops/onboarding/README.md).

## Run the interfaces

From `commerce-web/`, install the frontend workspace once and start either interface:

```sh
pnpm install --frozen-lockfile
pnpm dev:onboarding
pnpm dev:onboarding-ops
```

The customer wizard uses port 3100 and the staff shell uses port 3101. The wizard's anonymous draft preview works without the API. Account registration and server-synced drafts require the API and database; follow the [API local development instructions](../../commerce-api/onboard-api/README.md).

## Verify

Run from `commerce-web/`:

```sh
pnpm typecheck:onboarding
pnpm typecheck:onboarding-ops
pnpm build:onboarding
pnpm build:onboarding-ops
pnpm test:onboarding
```

The browser checks save the customer desktop and mobile previews to [`assets/`](assets/).
