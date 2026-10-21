# Language contract and release upgrade

This runbook covers the versioned Node → Python interpretation handoff and the
immutable language release lifecycle. It does not deploy a new release by itself.
Run the commands from `commerce-assistant-platform/app/commerce_language_engine` using explicit
operator `DATABASE_URL` credentials. Runtime credentials remain read-only for
release data; service restarts cannot publish or reactivate an archived release.

## Release identities

A deployment is the matching Node build, Python build, dictionary and corpus.
Preserve these together, including the previous compatible bundle for rollback.

A version 2 deployment bundle contains:

- The stable release UUID and its base release UUID.
- The exact immutable dictionary artifact and archived evaluation corpus.
- SHA-256 identities for artifact content, corpus archive contents and parser
  source/locked dependencies.
- Interpretation contract version `2`, normalization version `english-v1`,
  clause span encoding `utf-16-code-units`, and evidence span encoding
  `unicode-code-points`.
- A wrapper checksum and the release manifest.

Dictionary hashes use canonical JSON; the separately archived corpus is excluded
from that dictionary hash. Corpus hashes cover the original decompressed JSONL
bytes, preserving their ordering. Export does not relabel a release or silently
regenerate its content. Imports preserve the UUID and reject conflicting content
or base identities. Repeating an import with the same identity/content and
expected base does not create a second release.

Legacy version 1 bundles can still be decoded for explicit migration reads, but
normal startup rejects them and missing bundles. They cannot be imported as if
their missing release identity were verified. Export an existing immutable
database release by UUID or stage an explicit snapshot first.

The response carries `clauseSourceText` whenever it includes parsed clauses.
Clause offsets are UTF-16 code units into that exact source, which can differ
from the original message after a validated continuation or parsing transform.
Python validates each clause slice against this field. Meaning-evidence spans
retain their separate Unicode code-point encoding; consumers must not mix these
two offset systems or assume Python string indexes equal JavaScript indexes.

Python always compares version 2 dictionary provenance with its packaged
`compiled.json`. To also pin the intended parser build, set
`AI_LANGUAGE_RUNTIME_SHA256` to the bundle's `identity.runtimeSha256` in Python's
deployment environment. With this optional pin enabled, mismatched runtime
hashes and unverifiable legacy responses fail as `incompatible_release`.
`AI_LANGUAGE_GENERATION_FINGERPRINT` can additionally pin the dictionary
fingerprint; neither override can excuse a packaged-artifact mismatch.

## Prepare and migrate

1. Preserve a database backup, current active UUID, Node/Python image digests,
   compiled dictionary, deployment bundle and existing evaluation reports.
2. Restore that backup into a disposable database and rehearse migration and
   rollback there. Migration 022 is additive and records the existing active
   immutable release as the migration baseline; it does not publish shared
   authoring rows.
3. Create an empty database explicitly if this is a new installation. Startup
   no longer connects to an administrative database or creates databases.
4. Apply migrations with the operator account:

```sh
npm run migrate
```

The compatibility command `node scripts/deploy-start.ts --migrate-only` also
applies migrations only. It does not import or activate the image bundle. Shared
runtime credentials cannot use that command.

## Create an isolated draft

Read the current UUID using an operator query:

```sql
SELECT release_id FROM release.channels WHERE channel = 'production';
```

Prepare a complete reviewed dictionary JSON and corpus JSONL. The snapshot must
start from the immutable active release, rather than shared authoring tables that
could contain unrelated edits. Export that exact baseline if needed:

```sh
CLE_EXPORT_OUTPUT_DIR=/path/to/baseline npm run export:db-release -- \
  --release-id CURRENT_RELEASE_UUID --sync-authoring
```

Create a draft and keep the returned `draftId` and revision:

```sh
npm run release:draft-new -- \
  --artifact /path/to/reviewed-dictionary.json \
  --corpus /path/to/reviewed-corpus.jsonl \
  --expected-active CURRENT_RELEASE_UUID
```

Revise it with optimistic revision checking and a named change record:

```sh
npm run release:draft-revise -- \
  --draft-id DRAFT_UUID --revision 1 --change-key budget-grammar \
  --artifact /path/to/reviewed-dictionary.json \
  --corpus /path/to/reviewed-corpus.jsonl
```

Every revision preserves a complete snapshot. Freeze an exact revision:

```sh
npm run release:draft-freeze -- --draft-id DRAFT_UUID --revision 2
```

The result is an inactive immutable `releaseId`. For an already reviewed complete
snapshot, `release:stage` accepts the same arguments as `release:draft-new` and
creates and freezes its first draft revision in one operation.

Online `generate`, vocabulary imports and knowledge imports now stage inactive
candidates. Their output includes candidate identity. Generation does not reset
shared authoring tables. `prune:unsupported -- --apply` creates a candidate from
the active immutable baseline. `scripts/sync-industry-terms.ts` and
`scripts/sync-data-expansion.ts` now preview snapshot changes by default; `--apply`
stages the selected changes without modifying shared authoring tables. Projection publishing from shared tables is
rejected; use an explicit snapshot. None of these operations activates a release.

## Export and evaluate the exact candidate

Export by UUID before activation:

```sh
CLE_EXPORT_OUTPUT_DIR=/path/to/candidate npm run export:db-release -- \
  --release-id CANDIDATE_UUID
```

This writes `compiled.json` and `deployment-release.json.gz`. Add
`--sync-authoring` only when intentionally updating generated authoring files.
`export:release` verifies an existing version 2 bundle without inventing an ID
for unregistered filesystem files.

Evaluate the archived candidate with the runtime build intended for deployment:

```sh
npm run release:evaluate -- --release-id CANDIDATE_UUID \
  --report /path/to/candidate-evaluation.json
```

The `commerce-language-release-v1` gate requires compilation, valid version 2 wire responses with consistent
action/item/clause/relationship/graph links, and every archived case's expected intent, status and declared entity fields to pass. Empty corpora
are rejected. It records exact release, artifact, corpus, runtime, contract and
rubric identities and returns an `evaluationId`. Failed evaluations remain
recorded and the command exits nonzero. The existing development corpus may
expose known failures; a failed gate must be resolved and reevaluated, not marked
as passed manually. This strict regression gate does not establish independent
customer accuracy or catalog/workflow correctness.

The general `npm run evaluate` command remains diagnostic and writes its local
report. Its old `--database` option is rejected because it could not reliably
bind results to an exact release.

## Import into a deployment database

Restore/provision the expected base release with the same stable UUID first
(or use the explicit baseline import below for a new installation). Then import the candidate using its matching Node runtime checkout/image:

```sh
npm run release:import -- \
  --bundle /path/to/candidate/deployment-release.json.gz \
  --expected-active CURRENT_RELEASE_UUID
```

Import validates the entire bundle before staging and never activates it. A
candidate based on a different active UUID must be explicitly rebased and
reevaluated. Evaluate the imported UUID in the target operator environment to
obtain the target database's evaluation evidence.

## Promote and deploy

After staging validation, preserve the old compatible deployment and coordinate
the database promotion with the Node and Python deployment:

```sh
npm run release:promote -- \
  --release-id CANDIDATE_UUID --evaluation-id EVALUATION_UUID \
  --expected-active CURRENT_RELEASE_UUID \
  --actor OPERATOR_NAME --reason 'Reviewed candidate passed the release gate'
```

Promotion checks a passing evaluation for the exact candidate, runtime, contract
and rubric under a short transaction. The active release and candidate base must
still match the expected UUID. Concurrent or stale promotions fail; create a
rebased draft and reevaluate. `activate-release` is retained as an alias with the
same mandatory named options and checks.

Deploy the exported bundle with the same parser source/dependency identity and
its compatible Python decoder. Validate before admitting traffic:

```sh
CLE_DEPLOY_DATA_DIR=/path/to/candidate npm run verify:runtime
```

Both dedicated and shared normal startup require a version 2 bundle and verify
migration checksums, active release, artifact identity and the actual parser
runtime. Candidate releases must have passing evaluation evidence matching the
current runtime, artifact, corpus, contract and rubric; promotion evidence must
match the activation. Re-exporting an active dictionary with changed parser
source cannot bypass evaluation. Imported baselines must match their preserved
source runtime hash. An older image fails verification instead of changing the
database.
A successful verification supplies the verified database release UUID to the
server provenance envelope.

For the initial rollout, deploy a Python decoder that supports both legacy and
version 2 responses before enabling Node's version 2 response negotiation.
Validate real HTTP responses through Python routing, including relationships,
clauses, actions, references and span validation. Remove legacy compatibility
only in a later release after every consumer has migrated.

## Automatic first installation during full deployment

The full EC2 deployment runs `node scripts/install-empty.ts` with the dedicated database's operator credentials before starting its language service. The command uses explicit `DATABASE_URL` and `LANGUAGE_ENGINE_ADMIN_DATABASE` settings. It validates the packaged version 2 release and matching parser, creates the language database if missing, applies migrations, imports the complete dictionary/vocabulary/rules and bootstraps its active release. It preserves the exported UUID and content identities. No local database connection or generation step is required.

Database creation is serialized; schema migrations, import and activation form one transaction. Concurrent/repeated runs initialize once. An invalid bundle or failed activation cannot leave a partially seeded schema. A failure after database creation can leave an empty database, which the next run safely retries.

Any existing application schema, table, function, type or non-default extension causes a read-only skip, even if no release is active. Existing drafts and partially configured databases require the normal operator workflow. This installer does not apply upgrades to existing databases. Shared installations keep their explicit operator provisioning, and shared runtime credentials are rejected. Normal container startup and `--preserve-ai` never run this installer.

## One-shot empty installation

To initialize a fresh database from an existing complete release, preserve its
stable UUID and legacy fingerprint using the separate baseline import:

```sh
npm run release:import-baseline -- \
  --bundle /path/to/existing/deployment-release.json.gz --expected-active none
```

This requires a verified version 2 bundle exported by UUID, preserves an external
parent UUID as provenance, and does not fabricate local draft or evaluation
history. Repeated imports are idempotent. An imported baseline cannot acquire a
passing candidate evaluation; later updates need a new draft from the active
baseline. Importing into an existing database does not permit activation or
bypass promotion gates.

Alternatively, on a database with no current release and no activation history,
create/stage an initial reviewed candidate with `--expected-active none`, then
run `release:evaluate` for that UUID before serving it. Explicitly initialize
the active pointer with:

```sh
npm run release:bootstrap -- --release-id INITIAL_RELEASE_UUID \
  --actor OPERATOR_NAME --reason 'Reviewed initial installation baseline'
```

Bootstrap initializes a reviewed baseline and fails once an activation has
occurred. It does not make an unevaluated generated candidate eligible to serve;
startup still requires exact passing evidence. A verified imported baseline
uses its recorded source runtime identity. Normal service startup never performs
bootstrap.

A historical active release migrated from an older database has unknown runtime
provenance. For that migration only, an operator may explicitly set
`CLE_ALLOW_LEGACY_BASELINE_TRANSITION=true` when starting a reviewed, matching
version 2 export. The flag is off by default, does not excuse candidate evaluation
or a known imported-runtime mismatch, and should be removed after creating,
evaluating and promoting the first fully traced draft. It never alters data.

## Rollback

Stop/drain affected traffic as needed and retain new application/customer data.
Reinstall the previously compatible Node + Python + dictionary/corpus bundle.
Do not substitute an older database snapshot for a language release rollback.

```sh
npm run release:rollback -- \
  --release-id PREVIOUS_RELEASE_UUID --expected-active CURRENT_RELEASE_UUID \
  --actor OPERATOR_NAME --reason 'Incident reference and rollback rationale'
```

The target must be a recorded baseline or previously approved activation. The
command verifies the current UUID and records the actor, reason and previous
release. It does not deploy the matching binaries; complete that deployment and
run runtime verification before restoring traffic. Keep the additive migration
in place during ordinary rollback.

## Verification

Unit/CLI validation:

```sh
npm run typecheck
node --test tests/deployment-release.test.ts tests/db-release-export.test.ts \
  tests/release-cli.test.ts
```

The release CLI's real PostgreSQL test runs only when
`RELEASE_TEST_DATABASE_URL` points to a disposable administrative test server. It
creates random test databases and removes only that database afterward. It
rehearses draft freeze, explicit bootstrap, pre-activation export, idempotent
import, exact evaluation/promotion, stale-image rejection, parser-only re-export bypass rejection, content-tamper
rejection, legacy snapshot baseline import and rollback. It must not target the application database.

## CI installation fixture

CI runs the PostgreSQL lifecycle, importer and command tests against disposable
service databases; those checks must not silently skip for missing database URLs.
Offline generation runs in a temporary directory so it cannot replace the
reviewed contextual-knowledge artifact used by the integration suites.

The Compose CI job explicitly creates an empty `commerce_language` database,
then invokes `scripts/prepare-ci-release.ts` before building Node and Python.
The helper requires `CI=true`, `CLE_CI_BOOTSTRAP=true`, an explicitly named
loopback test database and an empty schema. It stages the current artifact,
evaluates the four authored installation-smoke cases, records evidence,
bootstraps the fresh database and exports matching version 2 build inputs. A
second run against an existing installation fails before modifying it. Local
tests always export to temporary directories; only the CI job intentionally
exports into the Docker build context.

These four cases verify CI installation and contract wiring. They are not
production release-quality evidence, an independent benchmark or a substitute
for the full release corpus. The helper is never invoked by ordinary startup or
production deployment.
