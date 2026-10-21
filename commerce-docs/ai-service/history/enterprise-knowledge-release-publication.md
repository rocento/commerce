# Enterprise knowledge release publication and rollback

> Historical record: identities, commands and results apply to the recorded candidate only.
> For current operations, use the [language release lifecycle](../language-release-upgrade.md)
> and [shared database runbook](../shared-database-operations.md). See the [history index](README.md).

**Historical candidate runbook:** a different combined release has since been published across all four demos. See the [production verification report](enterprise-knowledge-production-verification.md) for current identities and retained rollback assets. The expected-active UUIDs below are now stale; do not execute these commands against current production.

Prepared 2026-10-10. **Not executed.** These instructions apply only to frozen candidate `694122fc-b5dc-4cf0-b2c6-b5fecd7b75f9` and runtime `9f58fcc4a7394d61658310f8bcb37fbde3c3427345d876e20c4b19b1fa0a1182`. The Python exclusion defect is fixed. Final validation passed: 4,776 Python tests, 54 adversarial checks, repeated all-demo/HTTP checks and hash-bound image verification. These commands are prepared, not executed by this chat. The separately validated recognition-rule migration uses a different runtime/fingerprint. Its subsequent activation request is being handled in “Locate intent keyword handling.” Coordinate that operation first: if it changes the active release, these expected-active/base UUIDs are stale and must be rebased and reverified. Do not mix the images below with its differently fingerprinted dictionary. See [release evidence](enterprise-knowledge-release-repair.md).

## What the normal deployment scripts do

- `deploy/aws-deploy/deploy.sh` uploads the checkout's `ai-service/app/commerce_language_engine/data/compiled.json` and `deployment-release.json.gz`; it excludes `output/`. Therefore it does not select this prepared release automatically.
- `--sync-language-db` exports the active local database release, not the inactive reviewed candidate. `--sync-language-data` repackages local generated files. Neither is the publication operation for this candidate.
- `scripts/ec2-shared-ai-upgrade.sh` applies migrations using the shared owner, reapplies tenant policy and verifies the new runtime against the active release. It deliberately does not import, evaluate or promote a candidate. Its verification will fail while the new image and active UUID disagree.
- `scripts/ec2-deploy-ai.sh --service all --store all` is the only supported shared-language scope. It builds from the current remote source and verifies readiness. Do not invoke it on an unprepared checkout or use it to promote. Its comment saying startup activates the packaged release is stale; `deploy-start.ts` is read-only except for explicit `--migrate-only`.
- `scripts/ec2-compose.sh` already selects each store's protected shared-database credentials. Preserve these files and the shared database; do not restore retired per-demo AI databases.

The [read-only assistant schema decision](../../platform/evidence/README.md#evidence-231c55d4753a7f08) (`output/enterprise-knowledge-release-repair-20261010/final/assistant-migration-decision.json`), checked at 17:42 UTC on 2026-10-10, confirms that production already has the required effects of migrations 004–010 and forced tenant policies. All four demos have `domain_evidence` disabled. The reviewed 19-file Python overlay therefore requires **no new `assistant` migrations**. Preserve those flags and skip `conversations-setup.py`, which would also apply unused migration 011. Language database migrations and the exact candidate evaluation remain required. Recheck this decision if the schema or feature flags change.

## Exact publication sequence

Execute only after the final evidence verifier passes and the release scope is fixed. The four-tenant promotion and rollback rehearsal for this candidate has passed locally; a production evaluation is still required. Package the already verified images with `docker save`, transfer their archive plus checksum manifests and the final evidence/bundle to a protected release directory on EC2, and verify the transferred checksums. Loading these images avoids rebuilding from a mutable checkout. The production host is arm64, matching the captured baseline images.

Include the exact `final/operator-inputs/` tree and `operator-inputs-manifest.json` in that release directory, preserving its relative layout. Before any migration or import, refresh private custom-format backups of both databases, protected environment/configuration files and current images, and verify their checksums. The successfully restored backup at `/var/backups/rocento/enterprise-knowledge-prepublish-20261010.Y4C2AzBz` predates later traffic and does not replace this fresh backup.

The following commands run as root on the existing EC2 host. `FINAL_*` values must come from the final verified report; none is a value to guess. The candidate's bundle is already embedded at `/app/data/deployment-release.json.gz` in its Node image.

```sh
set -euo pipefail
cd /opt/rocento
exec 9>deploy/ec2/setup.lock
flock -n 9

FINAL_RELEASE_ID=694122fc-b5dc-4cf0-b2c6-b5fecd7b75f9
FINAL_LANGUAGE_IMAGE=sha256:f606a9d8a446d07c800b723751472b6967bf823fc6f0c7c928b9c1b0c84f8db9
FINAL_ASSISTANT_IMAGE=sha256:7d5d6ded450e8f843996d6108737d5aa756d202e491dcef6d656c24d69233f9d
FINAL_RUNTIME_SHA256=9f58fcc4a7394d61658310f8bcb37fbde3c3427345d876e20c4b19b1fa0a1182
FINAL_FINGERPRINT=6e01b06a8e3cbce4676116d9e33cefd80bdc266e2d4ac5268ac9151b6c19f9a2
: "${RELEASE_EVIDENCE_DIR:?Set the protected uploaded release directory}"
python3 - "$RELEASE_EVIDENCE_DIR" <<'PYVERIFY'
import hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1])
for name,digest in json.loads((root/'operator-inputs-manifest.json').read_text()).items():
    assert hashlib.sha256((root/'operator-inputs'/name).read_bytes()).hexdigest()==digest, name
PYVERIFY
docker image inspect "$FINAL_LANGUAGE_IMAGE" "$FINAL_ASSISTANT_IMAGE" >/dev/null

BASE_RELEASE_ID=80882336-f1a0-4cdf-bac3-1eebaccc58ea
BASE_RUNTIME_SHA256=c7f3c2f3b25adcab267acf2d2e208ee2c68424affcbde53f8465d680a36c0fad
BASE_FINGERPRINT=27f4c21a9b5d974fc66dca1460fd6805f4c358e68e89e4d95ca0c088d93d26d4
LANGUAGE_OWNER_ENV=/opt/rocento/deploy/ec2/shared-ai/language-owner.env
SHARED_NETWORK=rocento-grocery_assistant-private
SHARED_DATABASE=rocento-ai-shared-ai-postgres-1
STORES=(grocery electronics jewelry pharmacy)
language_owner() {
  docker run --rm --network "$SHARED_NETWORK" \
    --env-file "$LANGUAGE_OWNER_ENV" "$FINAL_LANGUAGE_IMAGE" "$@"
}

assert_node_ready() {
  local store=$1 release_id=$2 runtime_sha=$3 fingerprint=$4
  bash scripts/ec2-compose.sh "$store" exec -T commerce-language-engine \
    node --input-type=module - "$store" "$release_id" "$runtime_sha" "$fingerprint" <<'NODE'
import assert from 'node:assert/strict';
import {runtimeSha256} from './src/runtime-identity.ts';
import {readFileSync} from 'node:fs';
const [store,releaseId,runtime,fingerprint]=process.argv.slice(2);
const response=await fetch('http://127.0.0.1:3000/api/ready',{signal:AbortSignal.timeout(10000)});
assert.equal(response.ok,true);
const ready=await response.json();
assert.equal(ready.status,'ok');
assert.equal(ready.provenance.releaseId,releaseId);
assert.equal(ready.provenance.runtimeVersion,runtime);
assert.equal(ready.provenance.generationFingerprint,fingerprint);
assert.equal(await runtimeSha256(),runtime);
assert.equal(JSON.parse(readFileSync('./data/compiled.json','utf8')).generationFingerprint,fingerprint);
console.log(JSON.stringify({store,releaseId,runtime,fingerprint,passed:true}));
NODE
}

# Read-only preflight: check the active UUID and all four running identities.
CURRENT_RELEASE=$(docker exec "$SHARED_DATABASE" psql -X -U ai_owner -d commerce_language -Atc \
  "SELECT release_id FROM release.channels WHERE channel='production'")
test "$CURRENT_RELEASE" = "$BASE_RELEASE_ID"
for store in "${STORES[@]}"; do
  assert_node_ready "$store" "$BASE_RELEASE_ID" "$BASE_RUNTIME_SHA256" "$BASE_FINGERPRINT"
done
language_owner node scripts/check-release.ts

# Preserve old images before replacing mutable release tags.
docker image inspect sha256:f940d66da2d16ec7539c81f37a820df69dedb9e08c9ae652900aa88fdb08f957 >/dev/null
docker image inspect sha256:2b72ea7e9cd5728a9c6b4ff84b8b2a394b5d0f34d48514c9812156ae99ab7a06 >/dev/null
docker tag sha256:f940d66da2d16ec7539c81f37a820df69dedb9e08c9ae652900aa88fdb08f957 rocento-language-engine:rollback-20261010
docker tag sha256:2b72ea7e9cd5728a9c6b4ff84b8b2a394b5d0f34d48514c9812156ae99ab7a06 rocento-ai-service:rollback-20261010

# No assistant migration is needed for the verified current schema with domain_evidence off.
# Preserve existing tenant policies and feature flags. Do not run conversations-setup.py:
# it would apply the unused 011_domain_evidence.sql migration.
# See assistant-migration-decision.json and recheck if schema or feature flags change.

# Language migrations are additive. This does not activate the candidate.
language_owner node scripts/deploy-start.ts --migrate-only
docker exec -i "$SHARED_DATABASE" psql -X --single-transaction -U ai_owner -d commerce_language -v ON_ERROR_STOP=1 -f - \
  < "$RELEASE_EVIDENCE_DIR/operator-inputs/deploy/assistant/shared-language-tenants.sql"

# Import preserves the reviewed UUID and exact archived corpus.
language_owner node scripts/release.ts import \
  --bundle /app/data/deployment-release.json.gz --expected-active "$BASE_RELEASE_ID"
language_owner node scripts/release.ts inspect --release-id "$FINAL_RELEASE_ID"

# Production needs its own recorded evaluation; a local evaluation UUID cannot be reused.
language_owner node scripts/release.ts evaluate --release-id "$FINAL_RELEASE_ID" \
  > "$RELEASE_EVIDENCE_DIR/production-exact-evaluation.json"
EVALUATION_ID=$(python3 - "$RELEASE_EVIDENCE_DIR/production-exact-evaluation.json" "$FINAL_RELEASE_ID" "$FINAL_RUNTIME_SHA256" <<'PY'
import json, sys
r=json.load(open(sys.argv[1]))
assert r['passed'] is True and r['failureCount']==0 and r['wireFailureCount']==0
assert r['count']==136368 and r['rubricVersion']=='commerce-language-release-v1'
assert r['artifactSha256']=='1c60aa945090a45000e3f4cdda5c9c8236c4af1f1a31deb5a43ca729ae470b75'
assert r['corpusSha256']=='f32c3b98693f40e3a9bfc19c7cb55de0496e3a5e865b28faa1cc278798607c0a'
assert r['releaseId']==sys.argv[2] and r['runtimeSha256']==sys.argv[3]
print(r['evaluationId'])
PY
)
```

Drain or pause the assistant entry points, then stop both assistant components in all four stores. Do not leave some stores serving a different shared release during promotion. Existing commerce databases and other store services remain running.

```sh
for store in "${STORES[@]}"; do
  bash scripts/ec2-compose.sh "$store" stop ai-service commerce-language-engine
done

language_owner node scripts/release.ts promote \
  --release-id "$FINAL_RELEASE_ID" --evaluation-id "$EVALUATION_ID" \
  --expected-active "$BASE_RELEASE_ID" --actor enterprise-knowledge-publisher \
  --reason 'Validated enterprise knowledge revision 10 and repaired English parser'

docker tag "$FINAL_LANGUAGE_IMAGE" rocento-language-engine:release
docker tag "$FINAL_ASSISTANT_IMAGE" rocento-ai-service:release
```

Update `AI_LANGUAGE_GENERATION_FINGERPRINT` and `AI_LANGUAGE_RUNTIME_SHA256` in each protected `deploy/ec2/<store>-assistant.env` to the two final values, preserving all other keys, owners and modes. Retain the prior files for rollback. Leave `domain_evidence` disabled. The assistant image must contain the matching compiled artifact; a matching environment variable alone cannot repair a mismatched packaged artifact.

```sh
for store in "${STORES[@]}"; do
  bash scripts/ec2-compose.sh "$store" run --rm --no-deps --entrypoint node \
    commerce-language-engine scripts/deploy-start.ts --verify-only
  bash scripts/ec2-compose.sh "$store" up -d --no-deps --no-build --wait \
    --wait-timeout 300 commerce-language-engine
done
for store in "${STORES[@]}"; do
  bash scripts/ec2-compose.sh "$store" up -d --no-deps --no-build --wait \
    --wait-timeout 300 ai-service
  assert_node_ready "$store" "$FINAL_RELEASE_ID" "$FINAL_RUNTIME_SHA256" "$FINAL_FINGERPRINT"
done
```

Before reopening assistant traffic, read `/api/ready` from each Node container and `/ready` from each Python container. Assert all four Node provenance records equal the final UUID, runtime hash and fingerprint, and all Python readiness components are ready. Run the approved bounded English catalog sample across all four demos with the same product identity, strict budget and evidence checks used locally. Save results. Healthcheck success alone is not sufficient evidence of correct answers. Synchronize the exact frozen runtime/data/assistant source to the maintained remote checkout before any future source-building deploy; the running images do not update that checkout.

## Runtime rollback

Use the current candidate's operator image to move the shared channel to the previous vetted baseline, then restore both old images and the previous four environment files. Stop all eight consumers first, as for publication. This preserves customer writes and additive schemas. Do not restore SQL dumps as routine rollback.

```sh
for store in "${STORES[@]}"; do
  bash scripts/ec2-compose.sh "$store" stop ai-service commerce-language-engine
done
language_owner node scripts/release.ts rollback \
  --release-id "$BASE_RELEASE_ID" --expected-active "$FINAL_RELEASE_ID" \
  --actor enterprise-knowledge-publisher --reason 'Restore previously verified runtime'
docker tag rocento-language-engine:rollback-20261010 rocento-language-engine:release
docker tag rocento-ai-service:rollback-20261010 rocento-ai-service:release
```

Restore the saved four assistant environment files, including their prior fingerprint/runtime pin and existing legacy-baseline configuration, then run the same all-store `--verify-only` and `up --no-build` sequence, and call `assert_node_ready "$store" "$BASE_RELEASE_ID" "$BASE_RUNTIME_SHA256" "$BASE_FINGERPRINT"` for every store before the bounded sample. Use the baseline values in these rollback readiness assertions. The required baseline is UUID `80882336-f1a0-4cdf-bac3-1eebaccc58ea`, runtime `c7f3c2f3b25adcab267acf2d2e208ee2c68424affcbde53f8465d680a36c0fad`, fingerprint `27f4c21a9b5d974fc66dca1460fd6805f4c358e68e89e4d95ca0c088d93d26d4`. If old images were removed, verify and load the saved `runtime-images.tar.gz` before retagging. Never set the legacy-baseline transition flag to bypass a known candidate/runtime mismatch.

## Why the guards are effective

`check-release.ts` verifies packaged content and runtime identity but does not approve its corpus. `release.ts import` requires the bundle's runtime hash to equal the executing image and its base UUID to equal the active channel. `evaluate` executes every archived case under the unchanged rubric and checks that source identity did not change mid-run. `promote` requires a measured passing evaluation for the exact UUID, artifact, corpus, runtime, contract and rubric and atomically checks the expected active/base UUID. Runtime startup checks migration checksums, exact active artifact/UUID and that same evaluation identity. Python checks the packaged fingerprint and the configured runtime pin against the Node envelope.

Migration `032_delivery_question_knowledge.sql` widens the question-intent allowlist with `DELIVERY_DATE` and adds `knowledge-delivery-questions-v4` to the reviewed activation trigger while retaining the older allowed runtimes. It removes no columns or old intent/runtime values. Older runtime startup checks the migrations that it packages, so additional applied migrations do not alone prohibit rollback. The exact frozen candidate passed all four tenant promotion/startup/rollback checks, including old-runtime restart and stale-candidate rejection. Both saved production database dumps were independently restored on the same host in an isolated container and the resources were removed. These are rehearsal results, not evidence of production activation.
