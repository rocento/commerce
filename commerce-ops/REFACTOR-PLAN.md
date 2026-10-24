# Commerce operations refactoring plan

Status: source organization and local acceptance complete; compatibility retirement is deferred until consumers migrate. Updated 2026-10-23. This file owns the current progress record, next steps, documentation strategy, and retirement conditions. [COMMANDS.md](COMMANDS.md) owns the operator interface; [README.md](README.md) is the task entry point.

## Current progress and next priorities

The original findings below describe the migration baseline. Canonical ownership
is implemented for local/onboarding commands, Compose, provider adapters, host
operations, service assets, workflows, tools and tests. Final local acceptance
passed 568 tests across the main suite and localhost fixture run, with 21 optional
skips and 1,793 subtests. Historical results below remain attached to their batches.
No remote host or production deployment was exercised.

| Area | Current state | Remaining work |
| --- | --- | --- |
| Local platform and onboarding | Canonical implementation in `local/`; application code remains with its service | `scripts/local/` now retains compatibility links only; assistant and rengine host helpers live with their services |
| Compose | Canonical definitions in `base/`, `components/`, and `overlays/` | Preserve composition identities and retire old aliases only after caller review |
| Cloud adapters | AWS/GCP deploy adapters and shared libraries moved | GCP deploy/seed share their provider target loader; AWS retains its distinct field and host-validation contract |
| Demo seeding | AWS/GCP adapters call `cloud/seed-demo.sh`; canonical host implementation is `cloud/host/seed-demo.sh`, with the established EC2 command forwarding to it | Standalone seed upload and full-source activation both include the canonical implementation |
| Host operations | Renderer, checker, diagnostics, activation, job control, full/AI/rengine deploy, Compose, seed, protected bootstrap, bounded cleanup, AI preservation, publication configuration, and frontend build recipe moved | Service assets and remaining host helpers have canonical owners |
| Documentation | Phase reports and short Compose role pages are consolidated here and in `compose/README.md` | AWS operations notes consolidated into existing task/provider guides; retained EC2 provisioning and service-specific reference material stay with their owners |
| Service ownership | Contact, assistant, health-dashboard, observability, and rengine assets now have canonical `services/` owners; Compose, Docker build inputs, partial uploads, source fingerprints and full uploads use those owners | Native preview and its AWS controller are now canonical under `services/native-preview/`; installed paths remain stable |

Recommended execution order:

| Priority | Batch | Deliverable and completion condition |
| --- | --- | --- |
| Complete | Consolidate core documentation | Merge phase facts into this plan and Compose role descriptions into `compose/README.md`; remove the superseded files and update explicit documentation coverage. |
| Complete | Stabilize the migrated cloud paths | Ran the affected offline transport, activation, layout, seed, AI, host-job, and CLI fixtures. AWS/GCP target routing and demo-seed dispatch are covered; all 131 focused tests passed. |
| Complete | Finish host ownership | Host implementations and service helpers have canonical owners; installed wrappers and protected runtime paths remain stable. |
| Complete | Organize service assets | Contact, assistant, health-dashboard, observability, rengine and native preview have canonical service owners. The native controller installer and worker package retain their standalone runtime layouts. |
| Complete | Separate workflows, tools and tests | Release/demo/maintenance live under `workflows/`; checks/contracts/generation live under `tools/`; operations tests live under `tests/operations/`. Active evaluation commands and support packages now live under `tools/`; historical evidence harnesses remain under `scripts/`. |
| Complete locally | Audit compatibility and hand over | Audited 60 source symlinks and flattened two chains; consolidated AWS operational notes. Final local acceptance passed. Published aliases and installed wrappers remain under the retirement conditions in section 21. |

These are source and documentation batches. Production rollout requires its own explicit operation. No staging-server, backup, restore, or deployment-rollback feature is part of this plan.

## Historical migration record

This section replaces the per-phase reports. The results below describe the
scope and checks recorded at each batch; they are historical evidence, not a
claim that later changes have passed the same checks.

| Batch | Work retained in the canonical layout | Recorded evidence and limits |
| --- | --- | --- |
| Baseline (2026-10-22) | Mapped local, onboarding, release, AWS/GCP deployment, demo seed, and host diagnostics entry points. Recorded upload filters, private inputs, generated state, Compose identities, partial-upload consumers, and installed `/opt/rocento/deploy/ec2/` paths. | Initial checkout had 199 status entries. Focused fixture suites recorded 122 passing tests; documentation coverage recorded 200 Markdown files and 1,235 local links. Shell syntax and diff whitespace checks passed. No production command ran. |
| Local and onboarding | Canonical workstation code moved to `local/platform/`, `local/onboarding/`, and `local/preview/`; service-owned onboarding API/schema stayed in `commerce-api/onboard-api/`. Compatibility links preserve old local, onboarding, and Compose paths. | Resolved Compose JSON was compared for platform, assistant, demo, and isolated onboarding stacks. Recorded suites passed and documentation coverage was 203 files / 1,250 links. No containers or hosts were contacted. |
| Compose structure | Definitions were grouped under `compose/base/`, `components/`, and `overlays/{local,cloud,demos}/`. Callers set `--project-directory commerce-ops/compose`; project names, services, volumes, networks, and ports remain stable. | Eight resolved configurations were compared before and after; full and preserve-AI inventories were inspected. No containers started and no remote deployment ran. |
| Cloud libraries and providers | Shared transport, job, and source-filter helpers moved to `cloud/lib/`; AWS/GCP launchers and guides moved to `cloud/providers/`. Private target and credential inputs moved under ignored `.local/commerce-ops/`; AWS copy-dest and GCP direct-transfer strategies remain distinct. | File modes and normalized target structure were checked without exposing values. No cloud host was contacted and no deployment started. Legacy source paths remain compatibility links. |
| Service assets: Contact | Contact runtime, unit, and activation script moved from `deploy/contact/` to `services/contact/`; upload filters and the host installer use the service-owned path. | 73 contact, transport, activation, deployment, and release-gate tests passed using local fixtures. The separate contact HTTP fixture could not bind its loopback socket in the restricted test environment. Documentation checks passed at 210 files / 1,268 local links. No host was contacted. |
| Host operations (through current batch) | Renderer, checks, diagnostics, activation, job control, full/AI/rengine deployment, Compose execution, demo seeding, protected bootstrap reading, bounded cleanup, AI identity preservation, and publication configuration rendering are canonical under `cloud/host/`; frontend candidate building is canonical under `scripts/release/`. Established compatibility paths remain entry points. | On 2026-10-22, 92 focused tests passed after moving seeding/bootstrap; 81 cleanup/deployment tests passed after moving cleanup; 79 AI-preservation/activation/transport/layout tests and 40 preservation/publication/compatibility/upload tests passed; the frontend recipe/package/activation batch passed 77 tests (five optional Docker ingress checks skipped). All used local fixtures; no deployment or cloud-host access occurred. |

The baseline's command counts, test totals, and file/link totals are snapshots,
not current inventory. For the next validation work, use the current matrix
above and the owning fixture suites; do not treat historical results as proof
of current behavior.

## 1. Objective and scope

Make `commerce-ops` the clear home for running the platform locally, developing onboarding locally, preparing releases, deploying the Rocento platform, operating demo stores, and diagnosing installations.

Keep `commerce-ops` as the folder name. Keep Compose inside it; a separate `commerce-compose` root would split infrastructure ownership without solving the current coupling. Retain application implementations, database schemas, migrations, and service-owned contracts with their application owners.

Use a small command entry point, explicit targets, reusable service definitions, and provider adapters. Continue using the existing Bash, Python, Docker Compose, SSH, rsync, and systemd mechanisms during this migration. A folder reorganization does not require a new deployment platform.

Honor the current scope: no staging-server environment, backup jobs, restore commands, or deployment rollback machinery. SQL transaction rollback and cleaning temporary files are implementation behavior and should not be removed by a text search. Temporary upload directories remain part of deployment transport; they are not a staging environment. Failed deployment steps must report the affected state and allow a documented corrective retry without claiming automatic recovery.

## 2. Original baseline findings

| Finding | Why it matters | Proposed change |
| --- | --- | --- |
| `scripts/local/local-compose.sh` and `local-demo-compose.sh` load overlays from `deploy/ec2/` | Local development depends on a cloud-named folder | Move reusable topology overlays into Compose ownership |
| `aws-deploy/`, `gcp-deploy/`, and `ec2/server/` mix provider, execution location, and historical names | Operators cannot infer what runs locally or on a host | Use `cloud/providers/`, `cloud/host/`, and `cloud/lib/` |
| AWS target configuration and workstation transport/job helpers were recently centralized | Useful foundations exist, but their behavior has only received limited verification in this conversation | Verify them before any further moves; migrate these implementations rather than replacing them |
| Source filtering is shared by upload, inventory, and activation | A broken dependency can invalidate packaging or prevent host activation | Keep one canonical implementation and include it in every required package |
| `compose/` mixes base services, optional components, local settings, and demo-store overlays | File selection is difficult to understand | Organize by role and publish an explicit composition matrix |
| `scripts/` mixes generators, evaluations, release tools, demo changes, and operational tests | Ownership and side effects are difficult to discover | Separate workflows, development tools, and tests |
| `aws-automation/` is specifically an Android preview instance/session controller | Its name suggests general AWS provisioning | Place it with native-preview deployment assets under an explicit controller name |
| Deployment and service runtime ownership was mixed, including the Contact service | Install assets alone do not identify the runtime owner | Contact is now grouped under `services/contact/`; review the native-preview runtime as a separate service migration |
| `entrypoints.json` lists public commands alongside imported helper modules | A file list is not a reliable operator command catalog | Classify public entry points and internal modules separately |
| CI, tests, upload lists, and runtime mirrors embed source paths | A rename affects more than imports | Update all consumers in each migration batch |
| Local configuration, certificates, keys, caches, and historical scripts coexist with source folders | Directory listings are noisy and file movement can accidentally expose private inputs | Move private inputs to an ignored local configuration area; review historical scripts individually |

The working tree already contains substantial uncommitted work. Migration batches must preserve and distinguish those changes. Directory existence alone is not evidence that an old feature remains active: for example, the old durability directory may contain only local residue after tracked files were removed.

## 3. Proposed final structure

```text
commerce-ops/
├── README.md                     # Task entry points and ownership map
├── AGENTS.md                     # Editing rules and compatibility boundaries
├── COMMANDS.md                   # Operator interface and target rules
├── REFACTOR-PLAN.md               # One temporary migration plan and progress record
├── commands.json                 # Public command catalog
├── bin/
│   └── ops                       # Small dispatcher, no deployment business logic
├── local/
│   ├── platform/                 # Platform start/stop/status and local setup
│   ├── onboarding/               # Onboarding dependencies and setup entry points
│   └── preview/                  # Local device/simulator/proxy helpers
├── cloud/
│   ├── seed-demo.sh              # Shared workstation seed workflow; later workflows/demo
│   ├── providers/
│   │   ├── aws/                  # AWS target access and provider-specific preparation
│   │   └── gcp/                  # GCP target access and provider-specific preparation
│   ├── host/                     # Shared Ubuntu host activation and diagnostics
│   └── lib/                      # Transport, job handling, source filtering, root lookup
├── compose/
│   ├── base/                     # Shared service definitions
│   ├── components/               # Assistant, language, notifications, observability, etc.
│   └── overlays/
│       ├── local/                # Workstation ports, resources, networks, mounts
│       ├── cloud/                # Host runtime settings and shared AI topology
│       └── demos/                # Store-specific overrides
├── services/
│   ├── assistant/                # Image/configuration and initialization assets
│   ├── contact/                  # Contact runtime, unit, and activation assets
│   ├── health-dashboard/         # Installer, ingress, units and timers
│   ├── observability/            # Collectors, dashboards and alert configuration
│   ├── rengine/                  # Deployment-specific ingress/configuration
│   └── native-preview/           # Preview deployment assets and controller adapters
├── workflows/
│   ├── release/                  # Candidate qualification, evidence and release gates
│   ├── demo/                     # Reusable seed and catalog workflows
│   └── maintenance/              # Inventory, bounded cleanup and data repair workflows
├── tools/
│   ├── checks/                   # Repository and integration checks
│   ├── contracts/                # Cross-service generation and synchronization
│   ├── generation/               # Repository documentation/assets generation
│   └── evaluation/
│       ├── assistant/
│       ├── shopping/
│       ├── recommendation/
│       └── knowledge/
├── config/
│   └── examples/                 # Safe local and cloud target templates only
├── tasks/                        # Existing human runbooks; keep this name
└── tests/
    ├── unit/
    ├── integration/
    └── fixtures/
```

Create directories when content is migrated into them. Do not create empty placeholder categories. Native-preview platform/provider subfolders should only be added where actual implementations require them.

Private workstation state lives under repository-root `.local/commerce-ops/`; generated reports and evidence live under `commerce-output/`. Neither belongs in the source tree above. Installed host runtime paths are handled separately from source paths.

## 4. Ownership and dependency rules

| Area | Owns | Allowed dependencies |
| --- | --- | --- |
| `local/` | Workstation lifecycle and local development setup | Compose, local config, service assets, reusable workflows |
| `cloud/providers/` | Target resolution, credentials/access, provider-specific prerequisites | Cloud library and host interfaces |
| `cloud/host/` | Activation, host setup, health/status, locked service changes, demo seeding | Cloud library, Compose, service assets, release gates |
| `cloud/lib/` | Reusable operational mechanisms | Explicit configuration; no provider-specific application decisions |
| `compose/` | Service definitions and composition overlays | Application build contexts and service configuration assets |
| `services/` | Installation/configuration assets for deployed components | Applications remain with their service owners |
| `workflows/` | Operator tasks with explicit inputs and side effects | Local/cloud adapters and owned implementation modules |
| `tools/` | Development-time generation and checks | Application source contracts and tool dependencies |
| `tasks/` | How to perform tasks and interpret results | Canonical commands and service-owner documentation |

Local operations must not import a provider launcher or consume host-generated files. Host commands must not read workstation keys or local target files. Providers must not copy the shared release gate or service orchestration. Runtime consumers must receive their complete dependency set in partial uploads.

Onboarding remains a local development workflow in this plan. Its API, schema, and migrations stay in `commerce-api/onboard-api`. Merchant provisioning, billing, DNS, and cloud tenant creation require a separately specified lifecycle; they must not be silently introduced through the platform deployment command.

## 5. Rename and move map

| Current location | Proposed destination | Migration notes |
| --- | --- | --- |
| `tasks/` | Keep `tasks/` | These are the canonical runbooks; a rename adds link churn without changing ownership |
| `scripts/local/` | `local/platform/` or `local/preview/` | Classify by purpose; relocate imported modules with callers |
| `onboarding/` | `local/onboarding/` | Keep its isolated Compose project and service-owned schema |
| `deploy/aws-deploy/` | `cloud/providers/aws/` | Canonical launcher and docs moved; legacy forwarding paths remain until caller audit |
| `deploy/gcp-deploy/` | `cloud/providers/gcp/` | Canonical launcher and docs moved; preserve metadata, identity and direct-origin requirements |
| `deploy/ec2/server/` | `cloud/host/` | Phase 5 has moved activation, job control, renderer/checker, diagnostics, full/AI/rengine deployment, Compose execution, demo seeding, protected bootstrap reading, bounded cleanup, AI-preservation checks, and publication configuration rendering. |
| `deploy/ec2/configure.py` | `cloud/host/render_config.py` | **Moved in Phase 5 batch 1.** The old source path remains a symlink; activation installs to the existing protected host destination. |
| `deploy/ec2/publication.py` | `cloud/host/publication.py` | **Moved in current host-ownership batch.** Legacy callers forward to the canonical renderer. |
| `deploy/ec2/build-frontend.sh` | `workflows/release/build-frontend.sh` | **Moved in current host-ownership batch.** Candidate generation is release preparation; host deployment only verifies/promotes the reviewed export. The old path remains a forwarding adapter. |
| `deploy/ec2/*.yaml` | Appropriate Compose component/overlay | Classify by behavior, especially files used locally |
| `deploy/workstation-transport.sh` | `cloud/lib/transport.sh` | Preserve shell/runtime compatibility and SSH options |
| `deploy/workstation-job.sh` | `cloud/lib/jobs.sh` | Preserve job identities, source transfer strategies and reconnect behavior |
| `deploy/shared/source-filters.sh` | `cloud/lib/source-filters.sh` | Update inventory, activation and filter self-inclusion together |
| `deploy/contact/` | `services/contact/` | **Moved in current service-assets batch.** Runtime, unit, and activation assets share one owner; update host installation and uploads together. |
| `deploy/{assistant,health-dashboard,observability,rengine}/` | Matching `services/` folders | **Moved 2026-10-22.** Temporary directory symlinks support older checkout consumers. Full/partial upload and build consumers use canonical paths; old installed source copies are protected by the deployment exclusion. Remove aliases only after external checkout and installed Compose consumers are audited. |
| `deploy/native-preview/` | `services/native-preview/` | **Moved 2026-10-22.** Worker, capture adapters, package builder and service assets share an owner; source compatibility symlink retained. |
| `deploy/aws-automation/` | `services/native-preview/aws-controller/` | **Moved 2026-10-22.** Controller, installer, IAM policies and proxy snippets remain a standalone upload. Legacy source symlink retained; installed runtime paths unchanged. |
| `scripts/release/` | `workflows/release/` | **Moved 2026-10-22.** Release gates, packaging and frontend recipe use canonical paths in CI and host workflows. |
| `scripts/demo/` | `workflows/demo/` | **Moved 2026-10-22.** Seeds and sibling modules move together; standalone provider uploads use the canonical owner. |
| `scripts/maintenance/` | `workflows/maintenance/` | **Moved 2026-10-22.** Inventory, repair commands and SQL inputs retain their existing interfaces. |
| `scripts/{checks,contracts,generation}/` | Matching `tools/` folders | Move service-specific tooling to the service only where ownership is unambiguous |
| `scripts/evaluation/` | `tools/evaluation/assistant/` | Preserve current evaluation interfaces |
| `scripts/shopping_eval/` | `tools/evaluation/shopping/` | Preserve Python package imports; use valid module names |
| `scripts/recommendation_eval/` | `tools/evaluation/recommendation/` | Keep the fixed-corpus pipeline distinct |
| `scripts/knowledge-baseline/` | `tools/evaluation/knowledge/` | Keep active evidence tooling; review obsolete phase-specific harnesses |
| `scripts/tests/` | `tests/` | Classify unit/integration fixtures; fix root discovery and CI commands |
| `scripts/entrypoints.json` | `commands.json` | Migrate consumers and evolve its schema once |

Host source migrations completed so far include `ec2-up.sh` → `cloud/host/deploy.sh`, `ec2-activate-source.sh` → `activate-source.sh`, `ec2-status.sh` → `status.sh`, `ec2-doctor.sh` → `doctor.sh`, `ec2-deploy-job.py` → `deployment_job.py`, `ec2-seed-demo.sh` → `seed-demo.sh`, `ec2-bootstrap.sh` → `bootstrap.sh`, `cleanup.py` → `cleanup.py`, `ec2-preserve-ai.py` → `preserve_ai.py`, `deploy/ec2/publication.py` → `cloud/host/publication.py`, and `deploy/ec2/build-frontend.sh` → `scripts/release/build-frontend.sh`. Existing installed command paths remain compatibility entry points until callers and runtime paths are migrated together.

Use lowercase kebab-case for directories and shell entry points, snake_case for importable Python modules, and existing language conventions for other modules. Do not create a wrapper merely to make an imported Python filename use hyphens. Public command names should describe actions, not historical milestones or cloud brands when the implementation is shared.

## 6. Consistent operator interface

`commerce-ops/bin/ops` is implemented as a small dispatcher using the standard library. It resolves the repository root and invokes canonical implementations with argument arrays. Avoid constructing shell commands from user values or implementing a second orchestration engine.

Implemented command families are listed below as an interface overview. Use [COMMANDS.md](COMMANDS.md) and command help for complete arguments; this list is not a copy-and-run procedure:

```text
ops help
ops local platform up|down|status|logs
ops local onboarding up|down|status|logs
ops local assistant setup
ops local demo seed --store grocery
ops release prepare|check --candidate <id>
ops cloud plan --target production-aws
ops cloud deploy --target production-aws
ops cloud status|doctor|logs --target production-aws
ops cloud demo seed --target production-aws --store grocery
ops cloud demo seed --target production-gcp --store grocery
```

A local operation cannot silently select a cloud target. A cloud mutation requires an explicit target and prints the resolved provider, host, operation, and component scope before execution. Preserve supported direct script invocations during migration; switch the documented public interface after it is validated.

`plan` must have a defined read-only contract: report resolved target, artifact/evidence identity, service scope, and proposed uploads without invoking exporters, changing cloud configuration, or activating a deployment. Clearly document whether a plan needs SSH for comparison. Do not use the same name for a preview that performs hidden writes.

Release preparation, platform deployment, demo seeding, and onboarding remain distinct commands. Errors identify the operation and failed step and return a nonzero exit status. Help works without secrets, Docker, cloud credentials, or network access.

Expand the command catalog to record implementation path, owner, runtime, execution location, effect (`read`, `local-write`, `remote-write`), required target, and runbook. Imported modules belong in a separate dependency classification, not in the public command list. Generate the command index from this catalog to reduce documentation drift.

## 7. Configuration and secrets

Use explicit named targets, for example:

```text
.local/commerce-ops/
├── targets/
│   ├── production-aws.env
│   └── production-gcp.env
├── secrets/                      # Or references to existing external protected files
└── state/                        # Disposable workstation operational state
```

Retain safe KEY=value parsing for target files during the migration. Normalize common concepts such as provider, host, SSH user and SSH key path, while retaining provider-specific project/zone/instance fields. Reject unknown keys and malformed values; never source a target file as executable shell.

Set precedence deliberately: explicit command options, scoped environment overrides, then the selected target file. Never infer a production target from an unset value or default to a stored production IP. Migration must preserve the user's existing AWS target through the new local config without committing it.

Templates contain examples only. Keep certificates, tokens, bootstrap secrets and private keys out of Git, uploads, logs, generated indexes and release evidence. During secret relocation, preserve permissions and validate the new reference before retiring the old local location. Do not copy private values into the refactoring report.

Host runtime configuration remains under the existing protected `/opt/rocento/deploy/ec2/` layout for this source migration. A new host runtime layout would require its own installation migration and acceptance criteria.

## 8. Compose organization

Maintain one canonical service definition per component. Keep environment differences in overlays, and describe every supported combination in a small matrix:

Keep Compose-relative build contexts, bind mounts, and environment resolution
anchored at `commerce-ops/compose` when files live below it. Every caller using
nested canonical files must pass that directory through Docker Compose's
`--project-directory` option.

| Stack | Composition |
| --- | --- |
| Local platform | Base + local resource/port/mount overrides |
| Local platform with assistant | Base + assistant/language components + local topology overrides |
| Local demo store | Base + store overlay + required components + local overrides |
| Local onboarding | Isolated dependency stack owned by `local/onboarding/` |
| Cloud Rocento platform | Base + selected components + cloud topology/runtime configuration + store overlays |

Choose the final placement of `assistant.yaml` and `shared-ai-consumer.yaml` from their semantics, not their current EC2 location. Shared topology belongs to a reusable component; host-only settings belong to a cloud overlay.

Nested Compose files change relative build contexts, bind mounts, include paths and environment resolution. For each move, compare resolved service definitions before and after, using synthetic environment values and the same project-directory semantics. Preserve service names, project names, named volumes, networks, published ports, and persistent paths unless a separate behavior change is explicitly intended.

Keep the existing local project identity `commerce-ai` and store project identities through this migration. A folder rename must not create a new empty database volume.

## 9. Cloud and host boundaries

Provider code resolves and checks the target and supplies connection details. Shared transport manages SSH options, retries, uploads and status connections. Shared host commands own deployment locks, reviewed artifact activation, service configuration and diagnostics.

Preserve current behavior distinctions: AWS's copy-destination optimization and fallback, GCP's identity-key handling and direct-origin validation, selected AI preservation, separate migration upload, readiness marker ordering, and detached job monitoring. A shared helper should take a clear strategy or configuration value; it must not accumulate scattered provider-name checks.

Describe infrastructure prerequisites honestly. The current deploy launchers are not complete cloud resource provisioning. Record ownership of VM creation, firewall/security rules, IAM, DNS and certificates. If repeatable resource provisioning becomes required, introduce a separate declarative infrastructure project after choosing the supported cloud lifecycle. Do not introduce an empty infrastructure framework solely for folder symmetry.

Both provider adapters should satisfy the same observable contract for planning, deployment, status and error reporting. Provider-specific exceptions must be documented and tested with local fixtures.

## 10. Removal and deduplication rules

| Candidate | Action | Evidence required |
| --- | --- | --- |
| Old staging-server, backup, restore and deployment rollback commands | Remove remaining executable logic, callers, CI references and misleading docs | Confirm actual behavior; do not delete transaction rollback or upload staging by keyword |
| Empty obsolete directories and generated caches | Remove tracked residue; keep cache patterns ignored | Establish whether files are tracked, generated, or private |
| `.DS_Store`, `__pycache__`, generated evidence under source | Exclude and clean narrowly | Preserve user-owned/private data and active evidence |
| Dated scripts under `demo/history/` | Delete if superseded; turn recurring behavior into a parameterized workflow | Search callers, assess repeatability, document replacement |
| Two commands performing the same task | Keep one implementation and migrate callers | Compare inputs, side effects, outputs and dependencies |
| Python helper and similarly named CLI | Retain the separation if it is an intentional module/entry-point pair | Similar names alone do not prove duplication |
| Old directory compatibility wrappers | Remove after all callers and deployed installations are accounted for | Documented retirement condition, not elapsed time alone |
| Repeated runbook instructions | Keep one canonical procedure and link to it | Preserve provider-specific requirements |
| Ambiguous names such as `durability.yml` after backup removal | Rename to the actual remaining purpose, such as transaction reliability | Inspect workflow jobs and required status-check references first |

Git history preserves removed source. Do not create an `archive/`, `old/`, `legacy/`, or `misc/` dumping ground to avoid making ownership decisions. Temporary compatibility files should be listed in a migration register with their consumers and removal condition.

## 11. Markdown strategy: one owner for each topic

Keep four Markdown files at the `commerce-ops` root after consolidation: `README.md`, `COMMANDS.md`, `AGENTS.md`, and this temporary `REFACTOR-PLAN.md`. Keep the existing `tasks/` directory as the runbook home. Do not introduce a parallel `docs/`, `runbooks/`, or archive tree. The goal is fewer competing sources of truth, not one enormous manual.

### Document responsibilities

| Document | Owns | Must link out for |
| --- | --- | --- |
| `README.md` | Task routing and a short ownership map | Commands, provider setup, troubleshooting, migration history |
| `COMMANDS.md` | Public invocation, target precedence, command effects, supported provider capabilities | Detailed task procedures and implementation internals |
| `tasks/*.md` | End-to-end procedures: prerequisites, target, steps, expected result, failure response | Provider-specific setup and service-owned application details |
| `local/README.md`, `compose/README.md`, `cloud/host/README.md`, `scripts/README.md` | Area ownership, dependency boundaries, file selection where needed | Operator procedures already owned by task guides |
| `cloud/providers/{aws,gcp}/README.md` | Provider access, credentials references, VM prerequisites, provider-specific exceptions | Shared deployment, demo, release and diagnostic procedures |
| `config/README.md` | Template locations and configuration-file purpose | Target precedence already documented in `COMMANDS.md` |
| `AGENTS.md` files | Editing constraints scoped to their directory | Human setup and operator steps |
| `REFACTOR-PLAN.md` | Current status, next batches, compatibility register, dated validation limits | Normal operation after the migration |

Add a folder README only when it explains a distinct boundary or a non-obvious dependency. A README that repeats its directory name or its parent guide should become a paragraph in the parent. Application API contracts and product behavior belong to their application documentation.

### Concrete consolidation map

These are the next documentation edits; the current update establishes the plan and navigation, and does not claim these files have already been removed.

| Existing documents | Destination and action | Retirement condition |
| --- | --- | --- |
| `PHASE-0-BASELINE.md`, `PHASE-2-LOCAL-MIGRATION.md`, `PHASE-3-COMPOSE-MIGRATION.md`, `PHASE-4-CLOUD-LIBRARY-MIGRATION.md`, `PHASE-5-HOST-MIGRATION.md` | Merged into the historical migration record above. Retire the separate reports and create no new `PHASE-*` files. | Evidence remains dated and scoped; historical checks are not presented as current validation |
| Root README task table and `tasks/README.md` task table | Root README owns the routing table; task index links to it | One maintained task menu |
| `compose/base/README.md`, `compose/components/README.md`, `compose/overlays/README.md` | Merged into `compose/README.md`; retire the three short role pages | Parent retains composition matrix, path rules, and ownership descriptions |
| `deploy/README.md`, `deploy/ec2/README.md`, `tasks/rocento-platform-deployment.md` | Shared operator steps go in the task guide; host invariants in `cloud/host/README.md`; AWS provisioning details in the AWS guide | Inventory unique instructions before deleting either deployment guide; leave a concise compatibility map while old paths are supported |
| `cloud/providers/aws/how.md` and repeated AWS README procedures | Merge shared seeding into `tasks/demo-seeding.md`, diagnosis into `tasks/diagnostics.md`, AWS-only details into AWS README | Keep each unique procedure once; update inbound links before removing `how.md` |
| `deploy/aws-deploy/{README.md,SMTP.md,how.md}` and `deploy/gcp-deploy/README.md` | Retired on 2026-10-23; canonical provider and task guides own their content | Maintained incoming links now use canonical guides; executable compatibility paths remain |
| `local/platform/README.md`, `local/onboarding/README.md`, `local/preview/README.md` | Keep only area-specific contracts; put operator steps in the existing matching task or service guide | No duplicated startup/setup sequence; onboarding isolation remains explicit |
| `scripts/*/README.md` | Retain only useful ownership/command inventories; merge trivial indexes into `scripts/README.md` | Imports, effects and unusual dependencies remain discoverable |
| AWS `SMTP.md` and native-preview platform guides | Keep specialist guides while they contain distinct procedures | Consolidate only after reading their unique content; do not delete solely to reduce file count |
| Operations guides in `commerce-docs/` | Keep product context there; link to canonical ops procedures | No second copy of deploy, target selection, or seed steps |

### Writing and maintenance rules

1. Before adding Markdown, search the existing guides and extend the owning document. Split only for a distinct audience, operation, or substantial provider-specific procedure.
2. Each runbook names its owner, where commands run, explicit target, prerequisites, commands, expected success, failure diagnosis, and links to implementation. A failed write must explain how to inspect state before retrying.
3. Keep `commands.json` as the machine-readable catalog. `COMMANDS.md` explains it; it must not become a second inventory of every helper. Generate a complete command table only if needed, with a documented generator.
4. Link to the canonical procedure instead of repeating it. Provider guides describe access differences; the task guide describes the shared workflow. Use the same heading structure for AWS and GCP and state actual capability gaps.
5. Track source moves in this plan using current state, remaining work, affected consumers and retirement conditions. Historical pass counts must identify their batch and must never imply that later changes were tested.
6. Before removing or moving a guide, collect inbound links, Markdown anchors, catalog/runbook paths, symlinks, CI and documentation-checker references. Preserve useful content, update consumers, check links, then remove the superseded file. Add a redirect only for a known compatibility need with a removal condition.
7. Check maintained Markdown across all of `commerce-ops`, including `cloud/`, `local/`, `config/`, `COMMANDS.md` and this plan. Maintain the checker coverage as owners move instead of accumulating more ad hoc file entries.
8. After the migration is accepted, move lasting architecture rules into their owning guides, retain actual evidence in the existing evidence location, and retire this temporary plan. Do not create a replacement history folder.

Documentation acceptance: one task menu, one current migration record, one canonical procedure per operation, accurate AWS/GCP capability descriptions, no broken local links, and no historical test result presented as current validation.

## 12. Implementation sequence and completion gates

| Phase | Work | Completion gate |
| --- | --- | --- |
| 0 — Baseline and inventory | Record current changes; inventory commands, imports, fixtures, CI paths, upload lists, generated outputs, private inputs and installed paths. Run focused existing local tests for the recent refactors. | Reproducible baseline; failures classified; public commands and mutation boundaries mapped |
| 1 — Interface and target contract | Specify command catalog, explicit targets, configuration precedence, error/help behavior and runtime support. Add the thin dispatcher against existing implementations. | Help works offline; local/cloud selection is explicit; representative commands route correctly |
| 2 — Local and onboarding | Move local entry points and onboarding dependencies; relocate reusable EC2-named local overlays to their correct ownership. | Local startup composition and onboarding isolation preserved; no provider dependency from local commands |
| 3 — Compose structure | Move base/components/overlays in small batches and update contexts, mounts and composition selection. | Resolved configurations preserve identities, volumes, networks and intended ports |
| 4 — Cloud providers and shared library | Move AWS/GCP adapters and recent shared helpers; update target paths, source filters, release inventory and upload dependency lists. | Both provider fixtures pass; filtered packages include all required code and exclude private inputs |
| 5 — Host source and service assets | Move host implementations, renderers and service configuration. Install compatibility wrappers at legacy host paths as required. Current progress is tracked at the top of this plan; historical phase reports have been consolidated here. | Canonical and installed-path calls resolve the same implementation; locks, activation order and job monitoring preserved |
| 6 — Workflows, tools and tests | Move release/demo/maintenance workflows, classify tooling and imports, migrate tests and CI paths. | Command catalog matches real entry points; imports, generators and CI references resolve |
| 7 — Remove obsolete paths and duplicate docs | Retire proven-unused commands and compatibility paths; finish documentation consolidation started in priority 1; clear generated residue. | No unexplained old-path references or duplicate public implementations; exclusions still hold |
| 8 — Acceptance and handover | Run the agreed local verification matrix and publish the operator guide and remaining limitations. | Definition of done below is met; production rollout is separately scheduled |

Use one reviewable change per logical area. Avoid changing deployment behavior in the same batch as a path rename. Before advancing, complete the current phase's dependency updates and validation. If a batch fails, fix it before proceeding to the next batch; do not depend on deployment rollback tooling.

Do not rename all folders at once. The library and wrapper work already completed is a foundation for this plan, not a reason to redo it.

## 13. Verification matrix

- Existing local fixture suites: deployment transport, activation, layout, release gate, seed routing, AI deployment, script inventory and documentation. Inspect fixture side effects before executing; substitute transports and synthetic credentials where needed.
- Shared library compatibility: Bash supported by the workstation and host, paths containing spaces, execution from another working directory, missing config, invalid arguments, nonzero exit preservation, and unsupported targets.
- Upload manifests: full platform, AI-only, rengine-only, demo seeding, preserved-AI mode, and the canonical source filter itself. Verify that local configuration, keys, generated state and unrelated repositories are excluded.
- Installed compatibility paths: model `/opt/rocento/commerce-ops/...` and `/opt/rocento/deploy/ec2/server/...` in temporary fixtures; verify wrapper resolution and missing-dependency failure.
- Job lifecycle: failed transfer does not activate; readiness is written after complete configuration; an SSH interruption does not start a second deployment; locks serialize operations; failures retain a useful job identity.
- Compose: resolve each supported local/cloud/store combination with synthetic values; compare service and persistence identities; perform isolated local smoke checks where required.
- CI and documentation: command catalog coverage, Markdown paths, import paths, file-list references and workflow working directories. Update external required-check configuration if workflow check names change.

Run affected tests once after each meaningful batch; broaden when failures or dependency changes justify it. Syntax checks alone do not establish behavior preservation. Production deployment is not part of repository refactoring validation.

## 14. Definition of done

1. A new contributor can find local platform, onboarding and cloud tasks from one README.
2. Local commands do not depend on provider directories or cloud-generated configuration.
3. AWS and GCP have distinct adapters and share the operational mechanisms and host contract.
4. Every public command has an owner, target/effect classification, help and runbook.
5. Every runtime dependency is present in the matching full or partial package.
6. Configuration, secrets, generated outputs and source have explicit separate locations.
7. Compose moves preserve persistent identities and have a documented composition matrix.
8. Staging-server, backup, restore and deployment-rollback tooling remain outside this scope.
9. No obsolete command or wrapper remains without a named consumer and retirement condition.
10. Relevant local checks pass, limitations are recorded, and CI uses canonical paths.
11. Installed host paths and service identities remain compatible until an explicitly planned host migration.

## 15. Current service-asset batch and next work

On 2026-10-22, moved 29 assistant, health-dashboard, observability and rengine
assets into their `services/` owners. Updated Compose mounts and Dockerfile
paths, Docker build context exclusions, local setup, release inventories,
source fingerprints, full-source filters, AI/rengine partial uploads, and
operator documentation. Application runtimes, systemd identities, persistent
volumes and generated host state remain at their existing locations.

Compatibility: the four former `deploy/` directories are relative source
symlinks for older checkout consumers, including application test references.
Managed uploads exclude these old paths and preserve existing installed copies;
new consumers use `services/`. Audit installed Compose configurations and
external scripts before retiring either aliases or protected installed copies.
The health installer accepts both established locations plus its new canonical
location. Native preview and AWS automation are not part of this move.

Preflight validation also exposed stale theme-contract and removed script-wrapper
paths in the isolated contract generation fixture. It now copies the contract
from `commerce-api/rocento-api/` and invokes canonical `scripts/contracts/`
generators, preserving scratch-only generation.

Current validation (2026-10-22): 141 tests passed across deployment activation,
transport, layout, release gate, cleanup, agentic preflight, AI deployment, EC2
configuration, script layout, CLI dispatch, and documentation suites. The
managed-source fixture now checks all four service owners, rejects old asset
paths from uploads, and preserves existing installed legacy copies. Resolved
Compose JSON for base + assistant/admin/provider + observability is identical
before/after after normalizing only the intended service source paths. Changed
shell/Python syntax, four compatibility links and `git diff --check` passed.
The documentation checker passed 210 Markdown files and 1,269 local links.
Tests used local fixtures; no images were built, no services started, and no
cloud host or production deployment was exercised. Live database integration
and installed-host acceptance remain separate validation.

The next batches are workflows/tools/test organization,
and retirement of compatibility paths after consumer audits. Continue in dependency-complete
batches; do not repeat completed documentation consolidation or host moves.


## 16. Native-preview ownership batch — 2026-10-22

Moved the native simulator workers and their capture/packaging helpers into
`services/native-preview/`, and the Android lifecycle controller into
`services/native-preview/aws-controller/`. Public CLI arguments, sibling imports,
archive layout, systemd identities and installed runtime paths are unchanged.
CI, current mobile guides, package fixtures and controller instructions now use
canonical source paths. Historical records retain their original path claims.
The documentation checker scans the entire service tree so moved guides cannot
silently disappear from validation.

Both old deploy directories are relative compatibility symlinks for external
checkout consumers and historical runbooks. Retire them only after those
consumers are audited. Native preview is explicitly excluded from ordinary
platform source uploads; its independently reviewed worker packages and
controller installation remain the deployment interface. Removed the retired
`activate.py` from the standalone test inventory and corrected obsolete guide
text without restoring the one-time rollout.

Current validation: 88 focused tests passed (28 native worker/capture tests,
15 mocked controller tests, 5 packaging/install/layout tests, 22 transport tests,
and 18 documentation tests). Worker tests used the pinned Android requirements
in an isolated temporary environment and a temporary loopback HTTP server;
no AWS calls, emulator launches, device changes or production deployment ran.
Packaging tests cover canonical and compatibility entry points from outside
the checkout; controller installation uses temporary runtime paths and fake
systemd. Documentation checks passed 212 Markdown files and 1,271 local links.
Shell syntax and diff whitespace checks passed. Remote/native-device acceptance
remains separate from these local fixtures.

Next: migrate release/demo/maintenance workflows and developer tools with their
imports, CI consumers, command catalogs and test fixtures in dependency-complete
batches. Keep installed compatibility paths until their consumers are audited.


## 17. Workflow ownership batch — 2026-10-22

Moved 56 maintained files from `scripts/{release,demo,maintenance}/` into matching
`workflows/` directories. Updated the dispatcher, command inventory, CI filters
and commands, host callers, AWS AI/rengine partial packages, provider seed
packages, source inventory and managed-source filters. Shared Python helpers
retain snake_case names; executable names and arguments remain stable.
Development checks import demo helpers from the canonical workflow owner.

Old directories are compatibility symlinks for external checkout consumers and
historical runbooks. Managed uploads exclude those aliases and include canonical
workflows; existing old installed directories remain protected until their
consumers are audited. Do not remove them merely because in-repository callers
have migrated. The standalone seed package includes all required helper files.

Validation: 271 focused Python tests and 2 JavaScript tests passed. Coverage
includes full/partial upload boundaries, activation, fake-SSH seeding, release
gates and evidence, demo behavior, maintenance, command help outside the checkout,
catalog routing, and documentation. Stale root-helper imports and an old
theme-contract test path were corrected; contract ownership stays with the API.
Workflow Python/shell syntax, compatibility links, command implementations and
`git diff --check` passed. Documentation checks passed 214 Markdown files and
1,279 local links. Tests used isolated fixtures; no production writes, cloud
connections, live demo seeding or deployment ran.

Next: developer-tool ownership and test organization. Keep this batch's passing
results attached to its scope; revalidate consumers as the next folders move.


## 18. Developer tools and operations tests — 2026-10-23

Moved 52 check, contract and generation files from `scripts/` to `tools/`, and
moved the 63-file operations regression suite to `tests/operations/`. The
`entrypoints.json` inventory, CI jobs and path filters, host deployment
preflight, API documentation scanner, architecture checker, OpenAPI generators,
runbooks and contributor guides now use canonical paths. Contract sources remain
with their owning applications. The generated language-resolution type header
was refreshed from its canonical generator.

The Rust and AI architecture checkers scan code in its new owner. Partial AI
uploads include the canonical contract generators, and managed full-source
uploads include required tools/workflows while excluding test suites and old
script aliases. Compatibility symlinks retain the previous `scripts/checks`,
`contracts`, `generation`, and `tests` paths for checkout consumers. Evaluation
packages remain under `scripts/` because their runner and artifact ownership
need a separate pass. Retire aliases after callers and installed consumers are
verified.

A relocated Rust architecture test was still invoking the old script location;
updated it to call the canonical checker. The Node shopping worker also used a
relative path that resolved below `commerce-ops/`; corrected it to resolve the
language engine from the repository root. This was caught by the worker-backed
evaluation tests.

Validation: the full operations run reached 563 passed, 21 skipped and one
failure caused by that obsolete Rust checker test path. After correcting the
path, the Rust suite passed (8 tests plus 6 subtests); all 23 shopping evaluation
tests passed after correcting the worker path. The full run exercised 1,724
subtests. Documentation passed across 216 Markdown files and 1,286 local links;
Rust and AI architecture checks, generator synchronization, inventory path
checks, Python/shell syntax, Node syntax, and `git diff --check` passed. Skips
were opt-in integrations. No production deployment or cloud mutation ran.

Next: audit and move evaluation ownership, then decide whether compatibility
paths still have consumers. Keep application and service evaluations with their
owning applications.


## 19. Evaluation tooling ownership — 2026-10-23

Moved active evaluation commands to `tools/evaluation/` and their importable
Python support packages to `tools/shopping_eval/` and `tools/recommendation_eval/`.
This refines the proposed nested evaluation layout: sibling support packages
preserve Python import names and repository-root discovery without adding
forwarding modules. Application runtime, corpora, and retained report ownership
remain with their existing owners.

Updated CI working directories and path filters, command inventory, release
callers, tests, documentation and source-upload exclusions. Old script paths are
compatibility symlinks. The historical phase-3 verifier still references an old
evaluation path, so that alias has a known consumer. Installed consumers cannot
be verified from this checkout; retain the other aliases until that audit.
Historical knowledge-baseline harnesses remain in place because source hashes
and recorded artifact paths are part of their evidence contracts.

Validation: full operations run passed 544 tests and 1,718 subtests, with 21
optional skips; 20 local HTTP fixture tests could not bind sockets inside the
sandbox. Rerunning those two fixture files with localhost networking permitted
passed all 20 tests and 6 subtests. Thus all 564 operations tests passed across
the full run and targeted rerun. Shopping evaluation independently passed 23
tests; command layout, agent evaluation and classification tests passed 34 tests
and 123 subtests. Documentation passed 218 files and 1,288 local links; AI
architecture, shell syntax and diff whitespace checks passed. No evaluation
report was regenerated and no production command ran.

The active evaluation migration is complete. Compatibility cleanup remains
conditional on historical and installed consumer migration, rather than deleting
paths merely to simplify the source tree.


## 20. Remaining local host helpers — 2026-10-23

Moved `conversations-setup.py` to `services/assistant/` and
`configure-rengine-connections.py` to `services/rengine/`. These commands operate
on host services, so they no longer share ownership with workstation launchers.
Removed unused Python path injection; preserved arguments, migration ordering,
transaction behavior and runtime credential/data locations.

Updated full and partial AI deployment callers, the shared-AI upgrade command,
release fingerprints, AWS partial uploads, the command inventory and current
runbooks. Full-source filters include service implementations and exclude the
old aliases while protecting existing installed copies. Historical phase-3
evidence still references the old migration path, so the checkout alias remains.
`scripts/local/` now contains compatibility paths and its guide only.

Validation: 94 affected deployment, migration, transport, preservation, gate and
command-layout tests passed, including 225 subtests. The extended real-rsync
source-boundary fixture also passed. Both canonical and compatibility helper
entrypoints passed `--help` outside the checkout. Documentation passed across
218 Markdown files and 1,290 local links; modified shell syntax and
`git diff --check` passed. No production command or database migration ran.


## 21. Compatibility audit — 2026-10-23

Audited all 60 symlinks under the compatibility roots: 22 in `scripts/`,
17 in `deploy/`, 19 in `compose/`, and 2 in `onboarding/`. All resolve within
the checkout. The two EC2 Compose aliases chained through top-level Compose
aliases; both now target `compose/components/` directly. This removes an
intermediate dependency while retaining the public filenames.

Added a regression check for broken links, indirect aliases and targets outside
the checkout. Corrected the two current repository-reference guides that still
described host implementations under `scripts/local/`.

Retirement decisions:

| Compatibility group | Decision and condition |
| --- | --- |
| Historical evaluation and migration paths | Retain: `scripts/knowledge-baseline/verify-phase3.py` still names them as evidence inputs. Migrate that evidence workflow separately. |
| Workstation, provider and Compose paths | Retain published interfaces until operator callers have migrated. Repository caller searches alone cannot establish external usage. |
| Service, tool, workflow and test aliases | Retain during handover; current maintained callers use canonical owners. Remove only after dependent checkout tooling has migrated. |
| Installed host wrappers under `deploy/ec2/server/` | Retain: provider uploads and host commands deliberately use these stable installed entry points. They are not redundant source-only aliases. |

Source-upload exclusions continue to protect legacy installed copies; removing a
checkout alias must not silently change receiver deletion boundaries. No alias
was retired without consumer evidence, and no installed host was contacted.

Validation: 13 deployment/command-layout tests and 209 subtests passed,
including the compatibility-link audit. Documentation passed across 218
Markdown files and 1,290 local links; diff whitespace checks passed.
Next: consolidate overlapping deployment procedures, review shared provider
target parsing, then run final acceptance for the complete refactor.


## 22. Deployment guide consolidation — 2026-10-23

Retired `cloud/providers/aws/how.md` after moving its unique content into
existing owners: upload/activation/cleanup in `tasks/rocento-platform-deployment.md`,
seed behavior in `tasks/demo-seeding.md`, transfer and migration diagnosis in
`tasks/diagnostics.md`, and AWS contact/electronics setup in the AWS README.
Historical September migration repairs are explicitly labeled historical.
The old `deploy/aws-deploy/how.md` redirect now points to the canonical task
guide. Updated all maintained inbound links and explicit documentation coverage;
retained evidence inventories remain unchanged. Corrected the deployment source
map and obsolete migration-test invocation while preserving operational details.

Validation: documentation checks passed 217 Markdown files and 1,288 local links;
`git diff --check` passed. This batch changed documentation and checker coverage
only; no deployment commands were executed.

Next: review AWS/GCP target parsing for shared behavior, then complete final
acceptance and handover of the remaining compatibility contracts.


## 23. Provider parsing and final acceptance — 2026-10-23

Extracted duplicated GCP target parsing into `cloud/providers/gcp/target.sh`.
Deployment and demo seeding retain their original file-loading conditions and
argument/environment precedence. Provider-specific IPv4 discovery, key handling,
transport and activation remain in the launchers. AWS already had one loader;
its narrower field set and host rules do not justify a cross-provider parser.
The shared transport and job libraries remain the common provider boundary.

Added isolated parser tests for defaults, overrides, duplicate/unknown fields,
provider and user restrictions, symlink rejection and literal shell expressions.
Focused acceptance passed 27 tests and 102 subtests. Rust and AI architecture
checks passed. Final operations acceptance is recorded below.

Final acceptance: the main operations suite passed 548 tests and 1,787 subtests,
with 21 optional skips. The two localhost HTTP fixture files passed another
20 tests and 6 subtests with socket binding permitted. Total: 568 tests passed,
21 skipped, and 1,793 subtests passed. Documentation passed 217 files and 1,288
local links. Rust/AI architecture, modified shell syntax and diff whitespace
checks passed. No production deployment or cloud mutation ran.

Local source refactoring is ready for review. Retain this record while historical
callers, external checkout tooling and installed host interfaces still depend on
compatibility paths. Their eventual retirement and production rollout are
separate operations; no further source moves are required for this handover.


## 24. Handover review — 2026-10-23

Reviewed CI references, packaging references and the extracted GCP loader's
caller integration. No stale migrated paths were found in the checked CI and
packaging inputs. Added a missing launcher integration fixture: copies both
GCP launchers and the loader into a checkout with spaces, invokes them from an
unrelated directory, verifies seed arguments and CLI host precedence, and checks
that both reject an AWS target before transport. The write-capable seed workflow
is replaced by an argument recorder; no credentials or network are used.

This is additional focused review coverage, not a claim of production acceptance
or a rerun of the prior full suite. Source changes remain uncommitted for review;
pre-existing workspace changes have not been staged or discarded.


## 25. Configuration and inventory cleanup — 2026-10-23

Consolidated AWS/GCP target defaults under `config/examples/`. Provider and
legacy deploy template paths now link directly to those files; current guides
use the canonical templates. Clarified that GCP discovery settings are used
when HOST is omitted.

Moved the implementation inventory from `scripts/entrypoints.json` to
`config/entrypoints.json`, retaining a direct compatibility link. Updated its
consumers and filled public command routes missing from the old script-only
inventory. A consistency regression checks that public routes/delegates exist,
use canonical paths, appear in the inventory and have existing runbooks. The
public catalog's `legacy_inventory` key is preserved for schema compatibility;
its value points at the canonical inventory.

Marked scripts/deploy as closed to new command implementations while preserving
retained historical harnesses, installed adapters and deployment assets. Updated
service ownership descriptions and the repository map.

Validation: 24 command/layout/CLI tests and 244 subtests passed. Both provider
and legacy target-template paths resolve to their canonical config examples.
Documentation checks passed 217 Markdown files and 1,289 local links after
clarifying the operations test guide; diff whitespace checks passed.
No production operation ran.


## 26. Diff review and commit preparation — 2026-10-23

Reviewed accumulated status, deletion/replacement candidates, CI path updates,
root Docker context inputs, command inventory and symlink resolution. Every
inventoried command/data file exists; all 63 current symlinks resolve.
Documentation and Rust/AI architecture checks pass. This review is scoped to
operations integration; it does not certify unrelated application changes.

The checkout contains pre-existing onboarding renames, application changes and
retired durability/evidence tooling. Do not stage the entire repository or
attribute every deletion to this refactor. Git status alone cannot recover
which lines predated the task; preserve that uncertainty during staging.

Suggested commit boundaries, after reviewing mixed-file hunks:

1. Canonical operations owners, compatibility links, caller/CI/build-context
   updates and their regression tests. Keep moves and required consumers together.
2. Target-template and implementation-inventory consolidation, corresponding
   callers and consistency coverage.
3. Documentation consolidation and final handover record. Include any guide
   essential to a preceding behavior change with that change instead.

No files have been staged or committed. Exclude unrelated onboarding and
application changes unless separately reviewed for their own commits.

Fresh acceptance after inventory cleanup: main suite passed 550 tests and
1,820 subtests, with 21 optional skips. Localhost HTTP fixtures passed another
20 tests and 6 subtests. Combined: 570 passed, 21 skipped and 1,826 subtests.
The temporary test environment was recreated after the previous one disappeared.
Documentation passed 217 files and 1,289 links; architecture and whitespace
checks passed. No deployment ran.

## 24. Redundant file cleanup — 2026-10-23

Removed the four documentation-only redirects under `deploy/aws-deploy/` and
`deploy/gcp-deploy/`. They contained no unique procedures. Updated the deployment
index to link directly to canonical provider guides. Historical source hashes
and migration records remain unchanged. External bookmarks to these removed
Markdown paths must use the canonical provider or platform deployment guide.
Executable wrappers, source aliases, private state and historical evidence remain.
Removed disposable Python bytecode caches and Finder metadata under `commerce-ops/`.

Validation: 213 Markdown documents and 1,285 local links passed the documentation
checker; all 18 documentation regression tests passed. Diff whitespace checks
passed. No deployment or application runtime commands were executed.


## 27. Staged snapshot acceptance — 2026-10-24

Backup/restore retirement was committed separately as `4e55e78`. The main
refactor retains the currently committed onboarding package name in its staged
references; the separate working-tree onboarding rename remains uncommitted.

Exported the index into a separate checkout for acceptance. The first run
passed 544 tests, skipped 21 and found six failures: two fixtures depended on
private AWS configuration, and four worker tests lacked the generated language
dictionary in the export. Added explicit documentation-range fixture hosts to
the two tests and supplied the existing generated dictionary only in the test
export, without staging it. All 54 tests in the three affected suites then
passed, with 155 subtests; the 20 localhost fixtures also passed separately.
Staged documentation checked 212 files and 1,279 links; Rust/AI architecture
and index whitespace checks passed. The full suite was not rerun after these
two test-only corrections. No production commands ran.

Required documentation and caller changes are included with their moves so the
refactor commit is usable independently. Unrelated onboarding application/CI
changes and other unstaged application edits are excluded.
