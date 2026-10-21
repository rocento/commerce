# Testing and verification

Run checks appropriate to the owning service and changed behavior. Current commands and prerequisites are maintained in the service guides:

- [Backend checks](../../backend/development.md): formatting, Clippy, builds and isolated database-backed domain tests.
- [Frontend checks](../../frontend/development.md): lint, TypeScript, Vitest and scoped browser suites.
- [Mobile checks](../../mobile/README.md): native boundaries, build prerequisites and platform-specific acceptance.
- [Admin checks](../../admin-ui/development.md): permissions, navigation, forms, conflicts and browser fixtures.
- [AI checks](../../ai-service/local-development.md): architecture boundaries, Python suites, language tests and artifact verification.

## Shared checks

From the repository root:

```sh
python3 commerce-ops/scripts/check-documentation.py
python3 commerce-ops/scripts/check-migration-history.py
python3 commerce-ops/scripts/smoke.py
```

The documentation checker validates links, anchors, structure and owning indexes in maintained guides, including mobile and automation entry points. It rejects links directly into ignored local evidence folders; use the [evidence catalog](../evidence/README.md). Default validation must pass without those payloads. `python3 commerce-ops/scripts/check-documentation.py --check-local-evidence` additionally checks cataloged attachment sizes and hashes on a workstation holding the retained files. CI runs portable checks and regression tests. Migration source preflight does not verify applied database checksums unless the relevant database inspection is supplied. Smoke checks need the matching running stack.

## Browser and integration environments

The dedicated shopping staging setup, its browser and acceptance suites, and the evaluation lab's staging-only capture and outcomes commands have been retired. There is no maintained staging server requirement. Use the current service checks linked above; historical logs and source-hash records describe the removed tooling only at the time of those runs.

Inspect each Playwright configuration and global setup before running a suite. Mocked APIs, isolated disposable databases and real-service journeys have different evidence scope. The default admin suite needs a local administrator and required order fixture; other suites have their own role, inbox, service and mutation requirements. Keep test credentials in environment/private configuration.

Traces, screenshots and reports may contain local customer data. Use synthetic fixtures for mutation, concurrency, failure and rollback exercises. Inspect seed/setup scripts before running them; they can write data.

Publication tests and archived non-Markdown evidence retain their executable paths under `commerce-docs/platform/seo-geo/Tests`. `python3 commerce-docs/platform/seo-geo/Tests/check_documentation.py` validates current guide destinations and retained compressed archive hashes. It does not run publication acceptance. See [publication release checks](../../backend/publication.md).

Record the candidate revision, runtime/artifact versions, environment, exact commands, failures and skipped coverage. Transport completion and green unit tests do not establish successful live commerce or production readiness. Historical Markdown test summaries were removed rather than presenting their old results as current status.

## Release evidence

Use the [release readiness gate](release-readiness.md) to bind current, reviewed evidence to one candidate and acceptance environment. It reports missing coverage as blockers.

| Area | Required verification |
| --- | --- |
| Rust commerce | Migrated database, authoritative readiness, permissions and domain integration checks |
| Customer/admin UI | Relevant browser flows against identified backend and role fixtures |
| Merchant publication | Matching artifacts, bound origin, public-edge/private behavior, storage isolation, feeds and rollback |
| AI service | Tenant/key, parser fingerprint, scoped capabilities, persistence and provider acceptance as applicable |
| Deployment | Identified installation, release identity and environment-specific acceptance from the [release runbook](../../../commerce-ops/deploy/aws-deploy/how.md) |

Retained logs, manifests and compressed archives describe their recorded candidates only. Historical Markdown reports, staged prompts and the former Quality source tree were removed; missing attachments are not current verification. Keep useful executable publication harnesses and unique observations. See [cleanup policy](../reference/workspace-cleanup.md) for maintenance boundaries.
