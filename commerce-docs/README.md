# Commerce AI documentation

The current service guides are consolidated here. Start with the section that owns the behavior you are changing.

| Section | Responsibility |
| --- | --- |
| [Frontend](frontend/README.md) | Customer storefront, corporate website and shared packages |
| [Mobile](mobile/README.md) | Swift, Kotlin and React Native apps, App Studio and native previews |
| [Admin UI](admin-ui/README.md) | Merchant operations, permissions and store settings |
| [Backend](backend/README.md) | Rust gateway, commerce domains, API contracts and persistence |
| [Onboarding](onboarding/README.md) | Customer setup, staff shell and standalone onboarding API |
| [AI service](ai-service/README.md) | Language interpretation, bounded execution, providers and AI storage |
| [rengine](rengine/README.md) | Shopping-assistant diagnostics, rule visualization and performance tests |
| [Shared platform](platform/README.md) | Local setup, deployment, verification and recovery |

## Shared platform guides

[Platform documentation](platform/README.md) covers local setup, configuration, testing, observability, deployment and recovery. [The commerce API README](../commerce-api/rocento-api/README.md) provides the quickstart.

Shared platform guides, verification harnesses and retained evidence live in `platform/` within this documentation folder.

Service source lives under the repository root, including `commerce-web` (frontend apps, packages and onboarding interfaces), `commerce-api/rocento-api` (core commerce service), `commerce-api/onboard-api` (standalone onboarding service), `commerce-api/health-api` (health dashboard API and sampler), `commerce-corporate-site`, `commerce-mobile-apps` and `commerce-assistant-platform`. Compose files live in `commerce-ops/compose/` and `commerce-ops/onboarding/`; shared utilities live in `commerce-ops/scripts/`. New service documentation belongs in the corresponding section of this folder. Source-derived behavior and local checks do not establish live production acceptance.

## Writing and maintaining documentation

Follow the [documentation standard and cleanup policy](platform/reference/workspace-cleanup.md). Keep one canonical guide for each subject, use relative links, and distinguish current procedures from plans and dated release evidence. The [AI release history](ai-service/history/README.md) preserves candidate-specific records separately from operational guides.

Use each service index to find current guides, active plans and history. Start with the [mobile documentation](mobile/README.md) for material formerly spread across older frontend guides and mobile specification files. Source-adjacent READMEs and old guide paths provide entry points to their current owners. Retained local attachments are described by the portable [evidence catalog](platform/evidence/README.md); catalog entries do not imply that the attachment is included in a checkout or that an old result is current acceptance.

Run these checks from the repository root after documentation changes:

```sh
python3 commerce-ops/scripts/checks/check-documentation.py
python3 -m unittest discover -s commerce-ops/scripts/tests -p test_documentation.py
```
