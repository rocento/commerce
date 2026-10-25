# Commerce operations refactoring plan

Updated 2026-10-25. This temporary record owns migration status, remaining
compatibility decisions and dated validation. Use [README.md](README.md) for
folder ownership and tasks, [COMMANDS.md](COMMANDS.md) for invocation, and
[AGENTS.md](AGENTS.md) for lasting editing and naming rules.

## Current progress and next priorities

Canonical ownership is implemented for local commands, Compose, cloud providers,
host operations, service assets, workflows, tools and operations tests. No further
broad folder moves are planned. Application implementations, schemas and migrations
remain with their service owners; the separate onboarding rename is outside this
organization batch.

Retired 65 repository source symlinks and migrated maintained callers, including
assistant contract tests and documentation links. Installed deployment adapters
and receiver protection remain. Historical harness source stays unchanged and
requires its original checkout and inputs for reproduction.

| Remaining work | Completion condition |
| --- | --- |
| Retain installed interfaces | Keep the adapters below until host and external callers have an explicit migration and acceptance record. Repository searches alone cannot prove installed usage has ended. |
| Finish documentation handover | Lasting rules live in owner guides. Keep this concise record while compatibility decisions need it; retire it after acceptance without creating another archive tree. |

No production rollout, staging-server environment, backup, restore or deployment
rollback feature is included. Temporary upload staging and SQL transaction
rollback retain their existing meaning and behavior.

Documentation consolidation on 2026-10-24 passed the maintained-documentation
checker: 214 Markdown files and 1,284 local links. Diff whitespace checks passed.
This pass changes five guides only; it does not rerun application or operations suites.

## Alias-retirement acceptance — 2026-10-25

Reviewed all 65 deletions: each is a source symlink, not an implementation file.
Updated maintained callers and the installed source-filter adapter; preserved
legacy receiver exclusions and installed paths. Fixed seven Python test callers
and two language-test SQL references. Historical verifier bytes remain unchanged.

The clean staged export exposed a transport fixture copying a now-empty directory;
removed that dependency. Corrected a test variable collision and included the
onboarding guide's operations link independently of its API rename. After fixes,
all 91 selected operations tests passed, with 12 optional integration skips and
258 subtests. Staged documentation passed 213 files and 1,278 links; Rust/AI
architecture, shell syntax and index whitespace checks passed.

The affected assistant suites passed 626 tests with 2 skips in the working tree;
their nine changed test files match the staged export. Node checks passed 2 tests
with 2 database skips; both SQL paths resolve to the canonical service file.
No database integration, historical evidence regeneration, deployment or cloud
operation was performed. The separate onboarding rename and application edits
remain outside this commit.

## Compatibility register

| Retained files or boundary | Consumers and retirement condition |
| --- | --- |
| `deploy/aws-deploy/*.sh`, `deploy/gcp-deploy/deploy.sh` | Published provider entry points; remove only after their operator callers migrate to `cloud/providers/`. |
| `deploy/ec2/server/` adapters and `repository-root.sh` | Provider uploads and installed host commands; preserve `/opt/rocento/deploy/ec2/server/` until an explicit installation migration verifies replacement entry points. |
| `deploy/ec2/build-frontend.sh`, `deploy/ec2/publication.py` | Existing release/configuration callers; audit the installed interface before retiring them. |
| `deploy/ec2/bootstrap.env.example` | Distinct host-bootstrap contract, not a duplicate workstation target template; retain with provisioning guidance. |
| Old-path upload exclusions and receiver protection | Protect existing installations and reject stale source. Removing checkout aliases does not authorize deleting installed copies. |
| `scripts/knowledge-baseline/` | Historical evidence harness with sibling imports, source-hash and artifact-path dependencies. Preserve evidence; any reproducibility migration needs its own validation. |

The historical harness utility test still lacks phase-0 `benchmark-candidate.json`
and `benchmark-approved.json`. Do not fabricate replacements or claim it passed.
The alias-retirement review restored two proposed verifier input-path edits,
keeping historical source unchanged. Retired paths inside that harness describe
its original evidence inputs; they are not maintained command entry points.

See [deployment file classification](deploy/README.md#remaining-file-classification)
and [historical harness ownership](scripts/knowledge-baseline/README.md) for details.

## 11. Markdown strategy: one owner for each topic

This heading is retained for existing bookmarks. Permanent documentation rules now
live in [AGENTS.md](AGENTS.md#documentation-ownership); the root
[task menu](README.md#start-by-task) remains the only task routing table.

Completed consolidation merged phase reports into this record, Compose role pages
into [compose/README.md](compose/README.md), and AWS operational notes into the
existing task/provider guides. Redundant provider redirects were removed.
Specialist SMTP, native-preview and EC2 provisioning guides retain distinct content.
No parallel `docs/`, `runbooks/` or history directory is needed under `commerce-ops`.

## Historical migration record

The entries below preserve batch-specific results and limitations. They are not
current acceptance claims. Test and file totals are snapshots, not additive counts.
No recorded batch establishes production or remote-host acceptance.

| Batch | Work retained in the canonical layout | Recorded evidence and limits |
| --- | --- | --- |
| Baseline (2026-10-22) | Mapped local, onboarding, release, AWS/GCP deployment, demo seed, and host diagnostics entry points. Recorded upload filters, private inputs, generated state, Compose identities, partial-upload consumers, and installed `/opt/rocento/deploy/ec2/` paths. | Initial checkout had 199 status entries. Focused fixture suites recorded 122 passing tests; documentation coverage recorded 200 Markdown files and 1,235 local links. Shell syntax and diff whitespace checks passed. No production command ran. |
| Local and onboarding | Canonical workstation code moved to `local/platform/`, `local/onboarding/`, and `local/preview/`; service-owned onboarding API/schema stayed in `commerce-api/onboard-api/`. Compatibility links preserve old local, onboarding, and Compose paths. | Resolved Compose JSON was compared for platform, assistant, demo, and isolated onboarding stacks. Recorded suites passed and documentation coverage was 203 files / 1,250 links. No containers or hosts were contacted. |
| Compose structure | Definitions were grouped under `compose/base/`, `components/`, and `overlays/{local,cloud,demos}/`. Callers set `--project-directory commerce-ops/compose`; project names, services, volumes, networks, and ports remain stable. | Eight resolved configurations were compared before and after; full and preserve-AI inventories were inspected. No containers started and no remote deployment ran. |
| Cloud libraries and providers | Shared transport, job, and source-filter helpers moved to `cloud/lib/`; AWS/GCP launchers and guides moved to `cloud/providers/`. Private target and credential inputs moved under ignored `.local/commerce-ops/`; AWS copy-dest and GCP direct-transfer strategies remain distinct. | File modes and normalized target structure were checked without exposing values. No cloud host was contacted and no deployment started. Legacy source paths remain compatibility links. |
| Service assets: Contact | Contact runtime, unit, and activation script moved from `deploy/contact/` to `services/contact/`; upload filters and the host installer use the service-owned path. | 73 contact, transport, activation, deployment, and release-gate tests passed using local fixtures. The separate contact HTTP fixture could not bind its loopback socket in the restricted test environment. Documentation checks passed at 210 files / 1,268 local links. No host was contacted. |
| Host operations (through current batch) | Renderer, checks, diagnostics, activation, job control, full/AI/rengine deployment, Compose execution, demo seeding, protected bootstrap reading, bounded cleanup, AI identity preservation, and publication configuration rendering are canonical under `cloud/host/`; frontend candidate building is canonical under `scripts/release/`. Established compatibility paths remain entry points. | On 2026-10-22, 92 focused tests passed after moving seeding/bootstrap; 81 cleanup/deployment tests passed after moving cleanup; 79 AI-preservation/activation/transport/layout tests and 40 preservation/publication/compatibility/upload tests passed; the frontend recipe/package/activation batch passed 77 tests (five optional Docker ingress checks skipped). All used local fixtures; no deployment or cloud-host access occurred. |

### 15. Current service-asset batch and next work

Moved 29 assistant, health-dashboard, observability and rengine assets to `services/`, updating Compose, build inputs, full/partial uploads and release fingerprints. Fixed stale contract fixture paths. Installed identities and application ownership stayed unchanged.

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

### 16. Native-preview ownership batch — 2026-10-22

Moved native simulator workers and the Android controller to `services/native-preview/`. Preserved standalone packages, sibling imports, systemd identities and installed paths; native preview remains excluded from ordinary platform uploads.

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

### 17. Workflow ownership batch — 2026-10-22

Moved 56 maintained release/demo/maintenance files to `workflows/`, updating dispatch, CI, partial packages, seed packages and host callers. Python import names and public command arguments stayed stable.

Validation: 271 focused Python tests and 2 JavaScript tests passed. Coverage
includes full/partial upload boundaries, activation, fake-SSH seeding, release
gates and evidence, demo behavior, maintenance, command help outside the checkout,
catalog routing, and documentation. Stale root-helper imports and an old
theme-contract test path were corrected; contract ownership stays with the API.
Workflow Python/shell syntax, compatibility links, command implementations and
`git diff --check` passed. Documentation checks passed 214 Markdown files and
1,279 local links. Tests used isolated fixtures; no production writes, cloud
connections, live demo seeding or deployment ran.

### 18. Developer tools and operations tests — 2026-10-23

Moved 52 check/contract/generation files to `tools/` and 63 regression files to `tests/operations/`; updated CI, generators, architecture scanners and uploads. Corrected a Rust checker test path and the shopping worker root lookup.

Validation: the full operations run reached 563 passed, 21 skipped and one
failure caused by that obsolete Rust checker test path. After correcting the
path, the Rust suite passed (8 tests plus 6 subtests); all 23 shopping evaluation
tests passed after correcting the worker path. The full run exercised 1,724
subtests. Documentation passed across 216 Markdown files and 1,286 local links;
Rust and AI architecture checks, generator synchronization, inventory path
checks, Python/shell syntax, Node syntax, and `git diff --check` passed. Skips
were opt-in integrations. No production deployment or cloud mutation ran.

### 19. Evaluation tooling ownership — 2026-10-23

Moved active evaluation commands to `tools/evaluation/` with initially sibling support packages. Batch 28 superseded that package placement. Application corpora and retained reports stayed with their owners.

Validation: full operations run passed 544 tests and 1,718 subtests, with 21
optional skips; 20 local HTTP fixture tests could not bind sockets inside the
sandbox. Rerunning those two fixture files with localhost networking permitted
passed all 20 tests and 6 subtests. Thus all 564 operations tests passed across
the full run and targeted rerun. Shopping evaluation independently passed 23
tests; command layout, agent evaluation and classification tests passed 34 tests
and 123 subtests. Documentation passed 218 files and 1,288 local links; AI
architecture, shell syntax and diff whitespace checks passed. No evaluation
report was regenerated and no production command ran.

### 20. Remaining local host helpers — 2026-10-23

Moved assistant conversation setup and rengine connection configuration from local helpers to their service owners. Updated deployment callers, release fingerprints and partial uploads; retained credential locations and transaction behavior.

Validation: 94 affected deployment, migration, transport, preservation, gate and
command-layout tests passed, including 225 subtests. The extended real-rsync
source-boundary fixture also passed. Both canonical and compatibility helper
entrypoints passed `--help` outside the checkout. Documentation passed across
218 Markdown files and 1,290 local links; modified shell syntax and
`git diff --check` passed. No production command or database migration ran.

### 21. Compatibility audit — 2026-10-23

Audited 60 compatibility symlinks and flattened two chains. At that point published, historical and installed callers required retention. The later source-alias retirement supersedes source-link retention, but installed adapters and receiver protection remain.

Validation: 13 deployment/command-layout tests and 209 subtests passed,
including the compatibility-link audit. Documentation passed across 218
Markdown files and 1,290 local links; diff whitespace checks passed.

### 22. Deployment guide consolidation — 2026-10-23

Retired AWS `how.md`, moving unique deployment, seed and diagnostic instructions to existing task guides and AWS-specific setup to the provider README. Preserved specialist provisioning material.

Validation: documentation checks passed 217 Markdown files and 1,288 local links;
`git diff --check` passed. This batch changed documentation and checker coverage
only; no deployment commands were executed.

### 23. Provider parsing and final acceptance — 2026-10-23

Extracted GCP target parsing into its provider-owned `target.sh`, preserving caller precedence and provider behavior. AWS keeps its distinct loader; transport and job mechanisms remain shared.

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

### 24. Handover review — 2026-10-23

Reviewed CI and packaging references. Added a GCP launcher fixture covering checkout paths with spaces, invocation outside the checkout, seed arguments, host precedence and AWS-target rejection; transport and seed writes were replaced by fixtures.

Additional focused review coverage only; no full-suite rerun or production acceptance was claimed.

### 25. Configuration and inventory cleanup — 2026-10-23

Consolidated provider target defaults into `config/examples/` and moved the implementation inventory to `config/entrypoints.json`. Preserved the public catalog’s `legacy_inventory` field; its value points to the canonical inventory.

Validation: 24 command/layout/CLI tests and 244 subtests passed. Both provider
and legacy target-template paths resolve to their canonical config examples.
Documentation checks passed 217 Markdown files and 1,289 local links after
clarifying the operations test guide; diff whitespace checks passed.
No production operation ran.

### 26. Diff review and commit preparation — 2026-10-23

Reviewed deletion/replacement candidates, CI, build inputs and source inventory. Kept unrelated onboarding/application edits separate when preparing commits; status alone could not establish the origin of every change.

Fresh acceptance after inventory cleanup: main suite passed 550 tests and
1,820 subtests, with 21 optional skips. Localhost HTTP fixtures passed another
20 tests and 6 subtests. Combined: 570 passed, 21 skipped and 1,826 subtests.
The temporary test environment was recreated after the previous one disappeared.
Documentation passed 217 files and 1,289 links; architecture and whitespace
checks passed. No deployment ran.

### 24. Redundant file cleanup — 2026-10-23

Removed four documentation-only provider redirects after updating links; removed disposable bytecode and Finder metadata. Executable and historical content remained at this batch.

Validation: 213 Markdown documents and 1,285 local links passed the documentation
checker; all 18 documentation regression tests passed. Diff whitespace checks
passed. No deployment or application runtime commands were executed.

### 27. Staged snapshot acceptance — 2026-10-24

Exported the staged index separately from the working-tree onboarding rename. Backup/restore retirement was committed independently as `4e55e78`; canonical ownership followed in `1a1f830`.

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

### 28. Evaluation folder consolidation — 2026-10-24

Nested `shopping_eval` and `recommendation_eval` under `tools/evaluation/`, retaining Python import names. Updated worker imports, root discovery, CI, callers and uploads; runtime data and retained artifacts stayed in place.

Validation: 37 evaluation/command/deployment-layout tests and 242 subtests passed.
The extended real-rsync boundary fixture passed. Python compilation, Node syntax,
documentation links and diff whitespace checks passed. No production or retained
evidence-writing commands ran.

### 29. Remaining deployment file ownership — 2026-10-24

Moved website publication to `cloud/host/publish_website.py`, retaining its installed EC2 adapter. The implementation change was the policy-module path. Classified remaining deploy files and removed the inaccurate automatic-publication-rollback promise.

Validation: 29 publication/layout/activation tests and 243 subtests passed, plus
the extended real-rsync inclusion check. Documentation passed 213 files and
1,287 local links; diff whitespace checks passed. No production operation ran.

### 30. Historical harness organization — 2026-10-24

Completed the knowledge-baseline file index and documentation coverage. Retained its flat historical layout because sibling imports, old root assumptions and source hashes affect reproducibility. New evaluations belong in `tools/evaluation/`.

The existing Node utility test cannot load because its expected phase-0
benchmark-candidate JSON is absent; it also depends on benchmark-approved JSON.
Recorded this limitation instead of rewriting evidence or claiming a pass.
Documentation checks passed 214 files and 1,288 local links; diff whitespace
checks passed. No historical harness outputs or production state changed.

### 31. Naming and folder-guide cleanup — 2026-10-24

Audited active command names and documented Python wrapper/module conventions. Consolidated duplicate script menus and setup instructions into existing owner guides; preserved published and installed identities.

Validation: documentation checks passed 214 files and 1,280 local links;
`git diff --check` passed.

### 32. Combined organization review — 2026-10-24

Reviewed evaluation nesting, website publication ownership, historical indexing and guide cleanup together in a staged export. These changes were committed as `8d0b048`.

All 74 affected evaluation, layout, transport, website publication and source
activation tests passed, with 243 subtests. Staged documentation passed 213 files
and 1,274 links; Rust/AI architecture and index whitespace checks passed.
Confirmed the publisher's only implementation edit is its policy-module path;
all retained historical harness code remains byte-for-byte unchanged. Historical
benchmark fixtures are still unavailable, so that original utility suite is
not claimed as passing. No production operation or evidence regeneration ran.

## Dispatcher target boundary — 2026-10-25

Extracted named-target parsing and resolution from `bin/ops` into the
workstation-only `cloud/lib/targets.py`. The dispatcher passes its repository
root explicitly; command routing, provider precedence, restrictions and messages
are unchanged. Direct provider shell loaders retain their existing contracts.
Updated the implementation inventory, configuration guide and isolated CLI fixture.
The module is not required by host uploads and is not a public command route.

Validation: 19 CLI/layout tests and 159 subtests passed. Both extracted function
bodies match the previous implementation after root/error-class renaming.
Documentation checked 214 files and 1,284 links in the working tree. No deployment
or network operation ran; the separate onboarding rename remains excluded.

## Workstation transport lifecycle — 2026-10-25

Moved duplicate SSH control-connection and socket-directory cleanup from AWS/GCP
launchers into `close_workstation_transport` in the existing transport helper.
Provider EXIT traps retain their captured status and diagnostic messages. Upload
strategies, configuration transfer and activation sequencing remain unchanged.
No new files, public commands or host-upload dependencies were introduced.

Validation: 22 transport tests and 4 GCP target tests passed (9 subtests).
Local shell fixtures verified uninitialized cleanup, paths containing spaces,
and original exit statuses 0, 23 and 255 without SSH. All three changed shell
files passed syntax checks. No cloud operation or deployment ran.
