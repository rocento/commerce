# Knowledge revision 12 publication

> Historical record: identities, commands and results apply to the recorded candidate only.
> For current operations, use the [language release lifecycle](../language-release-upgrade.md)
> and [shared database runbook](../shared-database-operations.md). See the [history index](README.md).

Date: 2026-10-11. Status: published and verified on all four production demos. This report supersedes older candidate-specific commands for this release. Do not execute historical UUIDs from earlier runbooks.

## Changes

- Knowledge revision 12: **3,524 concepts, 5,628 forms and 94 governed rules**. Relative to production revision 10: +8 concepts, +48 forms and +5 rules, including both expansion batches. Recognition definitions remain 1,273.
- New recipient roles and occasion aliases retain their reviewed meanings. They do not imply product suitability or customer preferences.
- Contradictory adjacent price bounds now ask for clarification in Node before product retrieval. Quoted product titles retain literal meaning.
- Product-name identity probes preserve currency and inclusive/exclusive price bounds.
- Question-rule overlap checks reject impossible first-token matches before allocating search state. Release registration reuses verified content hashes. No validation or promotion gate was removed.
- Database operators can preview or apply reviewed alias edits to immutable draft revisions with stale-input guards and provenance. Broader concept/rule editors and rejected-row recovery remain future work.

## Frozen identities

- Active release: `eeeac359-a115-4df7-a9a7-e5ba310b8815`.
- Runtime: `1cccd00086e69da3f7f3071c436a785888381b2356651dd827f17abe161aa306`.
- Dictionary fingerprint: `79f0b56cba6e73824e4cbfb5bb184fac00a9d06ac25f6e2c946c0290d0248740`.
- Archived corpus SHA-256: `ab2eeef949c89c7f51d05213f8f9682338da867ce9346ca318fa492e69c36c79`, 136,372 cases. The four later production cases are preserved. JSON serialization differs from the prior archive; assertions and case content are unchanged.
- Rollback baseline freshly captured: release `489107a5-7555-4fc6-b623-549e4ad9ba64`, runtime `3eb47240fd6704f501b65e79583044c8667b93aa11afad9c093309d4a0b3051f`. Published Node image: `sha256:d4a91569ef049c3fa87a075ca29b78d228b2012afd758848ade43382ac02967d`; Python image: `sha256:77508445d1289dfda3b6904ec2ae4b5ad73c139b7408724607be2a27ebb56e9b`.

## Validation

The final knowledge-only runtime is validated independently of the held-back tracing producer.

- Node: **758 passed, 12 skipped**, zero failures; TypeScript passes.
- Archive: **136,372 passed**, zero semantic or wire errors, including the four newer production cases.
- New vocabulary acceptance: **40/40**; Python admission: **33/33**.
- Applicable Python broad run: **4,780 passed, 31 skipped**, with 17 setup errors caused by historical fixtures omitted from the source capture. Fixtures were restored; all affected suites pass **39/39**, including the 17 affected cases and 22 controls. No application change was required. This is reconciled evidence, not a claim that the initial run was clean. Python type checks pass for **256 modules**.
- Budget stream tests cover both legacy/core paths: clarification, no cards, no catalog search or model call.
- Captured real-catalog replay: **20/20** across all demos, plus four exact-name checks. The preceding combined candidate also passed all twenty against live catalogs after the exclusive-price fix.
- Final alternating fresh-process comparison: parser p95 **15.46→12.11 ms (−21.64%)**; compilation −12.79%, peak RSS −3.74%. All thresholds pass.
- End-to-end importer measurement: **1,023–1,028 concepts/s**, including finalization, over three interrupted/resumed imports. The final importer implementation hashes match that measured code; evidence is in `import-evidence.json`. These local measurements are not production capacity guarantees.
- Four-tenant promotion/rollback rehearsal passes against the exact freshly captured baseline: promoted runtime accepts, restored baseline restarts, inactive/stale candidates fail closed, cross-tenant sessions are denied, and mismatched evaluation evidence cannot promote.
- Both production database backups fully restored in an isolated networkless container on the same host. Archived row counts match; constraints and indexes validate; baseline artifact and corpus hashes match. Temporary container/volume removed. Customer data stayed on the host.
- Inactive production Node/Python canary passes all 16 semantic/contract checks and invalid-request rejection.

Earlier combined-candidate reports remain historical evidence; their 4,820-test suite includes unpublished tracing tests and is not the final release scope. `scope.json` records the isolated production-based overlays and applicable test selection.

## Publication and recovery

The user authorized publication and cross-chat coordination. “Improve rengine tracing” rolled back its producer twice on its unchanged latency gate and explicitly yielded production. This release preserves deployed gateway/rengine readers and excludes the unpublished producer overlay. The frozen successor starts from the restored production source, with only the knowledge/parser/catalog fixes applied. Knowledge revision 12 is now promoted and verified on all four demos.

Fresh protected backups are retained at `/var/backups/rocento/knowledge-revision12-20261011` on the production host. They include both database dumps, source, configuration and baseline image archive. The restore drill verified both databases without changing production or exporting customer data.

The hash-verified candidate passed its isolated canary, then all eight assistant consumers were stopped for the shared channel switch. Promotion used the expected prior UUID and exact evaluated runtime/artifact/corpus. Both runtime and fingerprint pins were updated and all four Node/Python pairs restarted healthy. **All four contract/readiness checks and 12/12 live guest shopping turns passed**: exact catalog names, newly added recipient wording under budget, and contradictory-price clarification. No commerce writes, model fallback or tracking-setting changes occurred. Independent final verification also confirmed the database projection: **3,524 concepts, 5,628 aliases/forms, 94 governed rules**, revision 12. Existing gateway/rengine reader images are unchanged.

Recovery entry point on the production host: `sudo bash /home/ubuntu/knowledge-revision12-20261011/rollback.sh`. This is a recovery action, not a verification command. It requires the current release **and all eight producer images** still to match this deployment, takes the setup lock, stops consumers, restores the baseline channel/images/source/pins and restarts all demos. It refuses after a later release or producer change, preventing a stale rollback from overwriting another chat's work. Recheck baseline readiness and identities after any recovery. Routine rollback does **not** restore SQL dumps over customer writes. Automatic rollback was armed during publication and was not needed.

The shared local checkout retains unpublished tracing producer changes. The deployed source and frozen snapshot are authoritative for this release; do not run a generic deployment from the mutable checkout until its tracing overlay has been independently validated and rebased on revision 12.

Temporary bulk-import performance databases, benchmark-only revisions 101/102, and test staging rows are not production inputs. Only the reviewed knowledge pack, compatible runtime and release provenance/corpus are published. Domain evidence remains disabled. Arabic and the stopped 4,000-case bulk live evaluation remain outside this release.

Final evidence: `output/enterprise-knowledge-v12-production-20261011/`. Earlier combined-candidate evidence (including the 4,820-test run and importer measurements) remains in `output/enterprise-knowledge-publish-batch2-20261010/`; it is not the deployed tracing producer. Final successor results are recorded above and in `local-verification.json`, `final-production-verification.json` and `production-live-check.json`. See [the active plan](../plans/enterprise-knowledge.md) and [alias authoring guide](../knowledge-authoring.md).
