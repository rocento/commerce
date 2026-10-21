# Repository map

| Location | Purpose |
| --- | --- |
| [`commerce-api/README.md`](../../../commerce-api/README.md) | Platform quickstart and overview |
| [`commerce-ops/README.md`](../../../commerce-ops/README.md) | Task routing for local work, onboarding development, platform deployment and operations |
| [Agent routing guide](../../../commerce-api/rocento-api/AGENTS.md) | Task ownership, scoped instructions and verification entry points |
| `commerce-api/` | Main and onboarding Rust packages with separate manifests and locks, plus the Python health dashboard API and sampler |
| `commerce-web/` | Storefront, merchant admin, Mobile App Studio, rengine and shared packages |
| `commerce-corporate-site/` | Standalone marketing and API documentation website |
| `commerce-mobile-apps/` | Native app source, optional Studio adapters, platform standards and build tools |
| `commerce-assistant-platform/` | Python assistant and Node language runtime; meaning, planning and language-resolution assets live in its `contracts/` folder |
| [commerce-docs](../../README.md) | Consolidated AI, frontend, admin UI and backend service guides |
| [Mobile documentation](../../mobile/README.md) | Canonical native development, App Studio, capabilities, plans and dated history |
| `commerce-ops/scripts/` | Agent guide, [entry-point manifest](../../../commerce-ops/scripts/entrypoints.json), canonical grouped implementations |
| `commerce-ops/scripts/contracts/`, `commerce-ops/scripts/generation/` | Contract generation/adapters and capability/asset generation |
| `commerce-ops/scripts/local/` | Local setup and Compose launchers |
| `commerce-ops/scripts/checks/`, `commerce-ops/scripts/evaluation/`, `commerce-ops/scripts/release/` | Repository checks, assistant evaluations and release/durability tooling |
| `commerce-ops/scripts/demo/`, `commerce-ops/scripts/maintenance/` | Demo helpers and maintenance operations; dated demo commands live in `demo/history/` |
| `commerce-ops/scripts/tests/` | Command and deployment regression tests |
| `commerce-ops/deploy/` | [Deployment entry point](../../../commerce-ops/deploy/README.md), service deployment and native preview worker tooling |
| `commerce-ops/deploy/aws-deploy/`, `commerce-ops/deploy/ec2/` | Workstation launchers, EC2 server commands, renderers, templates and protected generated configuration/state |
| `commerce-ops/deploy/aws-automation/` | Android preview lifecycle service, IAM policies, installer and mocked tests |
| `commerce-ops/compose/` | Application Compose files and optional service overlays |
| `commerce-ops/onboarding/` | Local dependencies for onboarding API development |
| `commerce-ops/tasks/` | Entry guides for local development, onboarding, deployment and recovery |
| `commerce-assets/`, `commerce-demo/` | Application/demo assets and presets |
| `commerce-docs/ai-service/history/` | Historical implementation and publication reports |
| `commerce-docs/platform/seo-geo/Tests`, `commerce-docs/platform/seo-geo/Reports/evidence` | Retained executable publication harnesses and non-Markdown observations |
| `commerce-artifacts/` | Existing retained test/evaluation evidence and generated outputs; classify before cleanup |
| `commerce-output/` | Existing run evidence, source snapshots, deliverables and builds; new runs separate `evidence/`, `deliverables/` and `work/` |
| [Evidence catalog](../evidence/README.md) | Portable attachment paths/hashes and availability records; payloads stay outside source control |
| `.local/` | Protected settings, credentials, working evidence and backups |
| `commerce-ops/compose/compose*.yaml` | Application and optional service stacks |

Project Markdown documentation belongs in the consolidated service sections or shared `commerce-docs/platform`. Runtime website articles use `.txt` source with JSON front matter and Markdown bodies. Installed dependencies retain their own managed documentation.

Build output and caches can regenerate; do not remove them while their jobs run. `.local`, `commerce-artifacts`, `commerce-output` and evidence may contain unique content or protected settings and are not disposable solely because of their names. See [cleanup policy](workspace-cleanup.md).

Canonical implementations and their compatibility entry points must ship together.
When moving another command family, update root discovery, imports, scratch-copy
fixtures, CI and deployment source lists before retiring old paths. Compose
files live in `commerce-ops/compose/`; service code and installed runtime paths retain
their declared locations. See the [command reference](scripts.md) for current entry points.
