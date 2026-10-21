# Admin development and validation

From `commerce-web`, use the workspace-pinned pnpm:

```sh
pnpm install --frozen-lockfile
pnpm dev:admin
pnpm --filter @commerce/admin typecheck
pnpm test
```

Admin listens on port 5174 and proxies `/api` to Rust port 8080. `API_PROXY_TARGET` and `API_PROXY_ORIGIN` override the development proxy. A backend, seeded role/user and required domain data are needed for authenticated real-service flows. [Backend local setup](../backend/development.md) describes prerequisites.

Focused browser commands include:

```sh
pnpm test:admin
pnpm test:admin:regression
pnpm test:grids
pnpm test:theme-editor
pnpm test:improvements
pnpm test:navigation
pnpm typecheck:e2e
```

The default admin Playwright suite uses `e2e/admin`, authenticates in global setup and reads `ADMIN_BASE_URL` or 127.0.0.1:5174. Other [Playwright configurations](../../commerce-web) have different fixtures, browser and gateway requirements. Inspect configuration before using a shared environment. Read-only tests, mocked component tests and real database mutation flows have different validation scope.

## Customer demo regression gate

`pnpm test:admin:regression` runs the consolidated synthetic admin suite, including session boundaries, direct-route permission checks, catalog grids, fulfillment, configuration, imports, theme sections, email templates, AI reports, notification campaigns and product relationships. It starts an isolated local admin server and does not require production credentials. `pnpm test:navigation` separately checks menu and translation publication through a synthetic storefront.

Run the frontend unit suite, admin typecheck, `pnpm typecheck:e2e`, and the admin build as well. Preserve the browser JSON report and failure traces; a successful mocked save does not establish live backend persistence, external email delivery or publication.

For a read-only integrity check against an identified live demo with a dedicated test account, use the existing private `ADMIN_TEST_EMAIL` and `ADMIN_TEST_PASSWORD` environment variables and run:

```sh
ADMIN_BASE_URL=https://admin.rocento.com pnpm exec playwright test e2e/admin/order-integrity.spec.ts
```

This visits every order returned by the paginated grid through the real detail API and verifies its payment obligation. It catches incomplete seed data that a page-loading smoke test misses. It must find at least one order. Run mutation suites only against isolated fixtures; the default admin suite also contains operational actions.

`e2e/admin/disposable-writes.spec.ts` adds opt-in real-service acceptance checks for an inactive product, inactive segment (including stale revision rejection), and empty media folder. Set `ADMIN_TEST_DISPOSABLE_WRITES=1` only for an authorized demo acceptance run. Each test changes only its own uniquely named records, deletes them in `finally`, and verifies removal. It does not publish products or campaigns, edit existing records, collect payments, or send messages. Preserve failed cleanup IDs from the test output for recovery.

The explicit bestseller seed creates an uncollected COD obligation alongside each synthetic order. For installations seeded before that invariant was enforced, `commerce-ops/scripts/maintenance/repair-bestseller-order-payments.sql` is a narrowly scoped repair for explicitly marked synthetic bestseller records. It inserts missing obligations only, is repeat-safe, and does not collect payments, change statuses or send notifications. Inspect its returned rows inside a transaction and roll back before approving any live application. Do not use a general payment backfill for real customer orders.

## Feature-specific checks

For component changes, run matching Vitest files, admin typecheck and focused browser checks when interaction/layout changes. Exercise read/write role separation, stale revisions, direct URLs, loading/error/empty states, keyboard navigation and narrow viewports. Shared API or contract changes also need client tests and the corresponding backend suites. Documentation-only changes use `python3 commerce-ops/scripts/check-documentation.py` from the repository root.

Email template checks use `pnpm exec playwright test --config playwright.email-templates.config.ts` (synthetic API fixtures on an isolated dev server), plus the `email-template-model.test.ts` and `email-templates.test.ts` Vitest files. The matching database-backed gateway suites are `cargo test --locked -p api-gateway --test email_templates --test notifications -- --test-threads=2` against an isolated PostgreSQL database. The delivery suite captures local HTTP inbox requests; it does not send to an external mail provider.

To inspect the actual built-in email renderer without a database or email provider, run `cargo run --locked -p api-gateway --example export-email-template-previews -- /tmp/email-previews` from `commerce-api/rocento-api`. The output directory contains HTML, plain text and JSON for all four templates with synthetic values. Inspect both desktop and narrow widths; browser rendering alone does not establish compatibility with every email client.

AI model report checks use `pnpm exec playwright test --config playwright.ai-reports.config.ts` with synthetic API fixtures on an isolated dev server. These cover model visibility, independent activity/outcome feeds, partial refresh failures, mobile layout and report permissions. Database regressions for model-usage aggregation live in `commerce-assistant-platform/tests/test_model_usage_postgres.py` and require an isolated PostgreSQL database via `M09_TEST_DATABASE_URL`.

Marketing notification checks use `node node_modules/@playwright/test/cli.js test --config playwright.marketing-notifications.config.ts` from `commerce-web`, with synthetic customer/program fixtures and an isolated Vite server. The client tests are `packages/api-client/src/marketing-notifications.test.ts`. Backend rendering and validation tests run with `cargo test --locked -p api-gateway --lib marketing_notifications`; the `marketing_notifications` integration suite needs isolated PostgreSQL. Run `cargo test --locked -p api-gateway --test marketing_notifications -- --test-threads=2` against that disposable database. Apply the new marketing notification migration before exercising the workspace against an actual gateway, and assign notification read, write, generate and publish permissions deliberately through Roles & permissions.

Order status management lives at **Sales → Order statuses** (`/sales/order-statuses`). `orders.statuses.read` grants access; editing also requires `orders.statuses.manage`. Order operators with `orders.write` can assign an active label within the order's current stage. Run `pnpm exec playwright test --config playwright.configuration.config.ts order-statuses.spec.ts` for the synthetic browser checks.

Status definitions keep a permanent code and workflow stage. Administrators can edit labels, translations, semantic token colors, customer visibility, and defaults; custom definitions can be archived. Defaults must be active and customer-visible. Built-ins cannot be archived. A replacement default applies on future entry into its stage, preserving current assignments. Label edits appear on existing assignments immediately. Reasons, revision checks, configuration audit records and per-order label history support review. Private labels fall back to the stage default in customer order responses. Label edits and assignments do not send notifications.

Native inbox validation also uses `packages/api-client/src/storefront-notifications.test.ts`, the `storefront_notifications` gateway integration suite against disposable PostgreSQL, and `playwright.storefront-notifications.config.ts`. Apply migration `20261004070000_storefront_notifications.sql` after the marketing-program migration. Public storefront SSR must remain free of personalized inbox content; only the hydrated browser restores a recipient session.
