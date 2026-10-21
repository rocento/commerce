# Enterprise knowledge — Phase 1 implementation

> Historical record: identities, commands and results apply to the recorded candidate only.
> For current operations, use the [language release lifecycle](../language-release-upgrade.md)
> and [shared database runbook](../shared-database-operations.md). See the [history index](README.md).

Date: 2026-10-10
Status: implemented and validated locally; revision 6 is staged, inactive. Production remains unchanged.

## Result

The existing knowledge-pack and release workflow now carries rule-level governance. The English candidate retains 563 concepts and 1,160 canonical/alias forms, and contains:

| Record | Count |
| --- | ---: |
| Relationship rules | 36 |
| Utterance rules / literal phrases | 20 / 339 |
| Question rules / templates | 11 / 31 |
| Inline budget rule / templates | 1 / 30 |
| Governed rules | 68 |
| Positive matching examples | 69 |
| Counterexamples | 140 |

Each rule has a stable family/identifier, version, English language and commerce domain, executor requirement, definition hash, applicability/output contract, precedence/conflict policy, examples, source, author, reason, status, and review identity. Reviews bind the exact definition, contract, provenance and examples. Editing those fields invalidates the review. The pack hash and existing immutable release artifact provide release membership; no second publisher or dictionary was introduced.

The recorded reviewer is `codex`, with method `ai_assisted`. These records do not claim independent human review. Examples test language matching, not product suitability or the correctness of a final shopping answer. The Phase 0 owner-approved benchmark and its 16 reserved cases remain unexecuted.

## Storage and validation

Migration `028_rule_governance.sql` adds these records to `commerce_language`:

| Table/view | Purpose |
| --- | --- |
| `knowledge.budget_rules` | Literal inline-budget templates and fixed MONEY-slot output |
| `knowledge.rule_governance` | Versioned review records, contracts, examples and provenance |
| `knowledge.rule_reviews` | Readable operator view for inspection in DBeaver |

Existing `knowledge.packs`, `knowledge.rules`, `knowledge.utterance_rules`, `knowledge.question_rules`, and `release.*` records remain authoritative. Imports and generic draft/stage paths share one relational projection. Foreign rule references and updates/deletes of the new records are rejected. Candidate creation remains transactional and inactive.

Validation rejects missing records, unknown references, unsupported executor requirements, stale reviews, malformed examples, changed definitions without new rule versions, and changes to a governed pack without a new pack revision. Once adopted, a governed pack cannot be silently removed or replaced by an ungoverned candidate. Historical packs remain readable for compatibility and explicit vetted rollback.

Drafts can compile and be evaluated. Application promotion/bootstrap checks require reviewed records; a database activation trigger also rejects incomplete or draft review records, including an older operator attempting activation directly. Existing exact-candidate/runtime/corpus evaluation gates remain in place. Review metadata is operator-authored provenance, not an authentication system or a cryptographic reviewer signature.

Rules contain no executable code. Budget templates permit one MONEY slot and bounded literal syntax. Current format limits include 32 budget rules, 100 total budget templates, 2,000 governed rules, 20 positive and 20 negative examples per rule, 512 question templates, 2,048 expanded question/device frames, and a 2,000,000-step question-overlap analysis budget. These conservative limits need deliberate revision and measurement before larger Phase 2 packs; this phase does not establish million-rule capacity.

## Migration decisions

The inline form “my/our/the/a budget/limit [is/of] MONEY” is now supplied by `budget.inline.maximum`. The executor retains numeric/currency parsing, complete-suffix consumption, read-only context, and safety boundaries. It does not accept arbitrary regex, executable expressions, new slot types, or write intents from these records. An explicitly empty published budget list disables this behavior; it cannot fall back to the legacy pattern. The old pattern remains only for immutable pre-governance packs.

Two old rules, `modifier.color` and `modifier.audience`, were unreachable because every target concept requires explicit context and the prefix executor rejects such concepts. Revision 6 omits these inactive rules. Explicit color/audience relations remain present. Regression replay confirms no entity-output changes in the exposed corpus.

The overlap analysis found one pair: `question.material` and `question.price`. Both records explicitly declare that conflict. Existing question execution rejects competing interpretations rather than selecting a rule by storage order. For example, “what is the current price of laptop made of” does not choose one interpretation. Overlapping variants within one question rule retain the same fail-closed behavior when their extracted arguments disagree. New undeclared cross-rule overlaps fail validation.

## Example explanation

For “I need a laptop for video editing and my limit is $75.” the candidate resolves a product search with `productText=laptop` and maximum price `75 USD`:

| Source rule | Version | Matched text | Unicode code-point span |
| --- | ---: | --- | --- |
| `for.activity` | 1 | `for video editing` | `[16,33)` |
| `budget.inline.maximum` | 1 | `and my limit is $75` | `[34,53)` |

The diagnostic command reports the pack/fingerprint, source, version and review method alongside these spans. It does not change the public Node-to-Python action/entity contract or assert that a suitable laptop exists at that price.

## Verification

- Full Node suite with PostgreSQL and HTTP checks enabled: **688 passed, zero failures or skips**, recorded in `output/enterprise-knowledge-phase1-20261010/all-tests-with-db.log`.
- Focused governance suite: 9 passed. Includes 1,440 budget-template/currency/separator combinations; malformed syntax; stale review/version checks; unknown references; overlapping rules; negative and ambiguous limits; Unicode spans; and a follow-up budget correction retaining the product and intended use.
- Disposable PostgreSQL release/import suite: 20 passed, zero skips. Covers migrations, atomic import, immutable records, idempotency, exact content, unreviewed activation rejection, version/downgrade prevention, and rollback.
- TypeScript typecheck passed. Existing HTTP and wire-contract tests passed; the public response format is unchanged.
- Historical replay: 4,000 conversations / 4,675 turns, with the original frozen rubric. **1,277 conversations and 1,440 turns pass**, exactly as in Phase 0. **Zero regressed checks, zero improved checks, and zero changed entity rows.** These results demonstrate preserved behavior, not new coverage or verified live answers.
- Same local performance harness: p95 **8.65 ms** versus **8.64 ms** (+0.10%); peak harness RSS **488.14 MiB** (+1.44%). Both are below the predeclared +20% investigation thresholds. Load/compile increased from about 81 to 192 ms because rules now undergo review/example/conflict validation at load time. The memory number includes the evaluation data and harness. These are sequential local measurements, not production capacity/SLA results.
- Phase 0 artifact/input verification passed. Reserved cases were not evaluated or imported into the database.

## Local database state

A local backup was saved before migration at `/private/tmp/commerce-phase1-before.dump`. The local database was behind production at migration 021, so migrations 022–028 were applied locally. The active release stayed unchanged.

| Identity | Value |
| --- | --- |
| Local active release, still revision 5 | `4d29d56d-5e4c-45bd-96b8-83ba9b7177b2` |
| Local inactive revision 6 candidate | `6e3450b1-753e-4ea6-845e-0a8afe6a571b` |
| Candidate fingerprint | `17fd36420f86f34af5b579251a20f0897bff8c507db039f526386b8494335991` |
| Pack SHA-256 | `704e9a06b35850dc032b38d3fff576df19a53ec3bf68330ea00ab161a5436330` |
| Candidate runtime SHA-256 | `d0fb0c88a6b8107ba13c37f7ddc0a93f24c0cc8bf870db57c3cd1e6b0a61da1d` |

Local relational records were compared against the exact reviewed JSON pack. Production has not received this migration, pack, or runtime.

In DBeaver, connect to the **local** `commerce_language` database and run:

```sql
SELECT * FROM knowledge.rule_reviews
WHERE pack_code='shopping-english-v1' AND pack_revision=6
ORDER BY family, rule_code;

SELECT b.* FROM knowledge.budget_rules b
JOIN knowledge.packs p ON p.sha256=b.pack_sha256
WHERE p.code='shopping-english-v1' AND p.revision=6;

SELECT * FROM release.production_status;
```

## Reproduction and rollout

Run these from `ai-service/app/commerce_language_engine`:

```sh
node scripts/govern-knowledge.ts validate \
  --base data/compiled.json --pack data/knowledge/shopping-en-governed-v1.json

node scripts/govern-knowledge.ts explain \
  --base data/compiled.json --pack data/knowledge/shopping-en-governed-v1.json \
  --text 'I need a laptop for video editing and my limit is $75.'

npm run typecheck
npm test
```

For database-backed tests, set the existing `LANGUAGE_KNOWLEDGE_TEST_DATABASE_URL`, `LANGUAGE_RELEASE_TEST_DATABASE_URL`, `RELEASE_TEST_DATABASE_URL`, and `ENGLISH_VOCABULARY_TEST_DATABASE_URL` to a disposable-test administrative connection. Tests create and remove UUID-named databases; never use a production administrative endpoint for these tests.

`prepare-governed-knowledge.ts` reproduces the initial draft from a pre-governance pack. It writes a new file and does not approve it. `govern-knowledge.ts review` requires an explicit reviewer, `human` or `ai_assisted` method, and new output path; compile/example checks must pass before it records a review. Review is not activation.

For a future rollout, follow [the existing release runbook](../language-release-upgrade.md). Back up and migrate the target, export its current immutable release, then dry-run and apply the pack against its verified active fingerprint:

```sh
npm run import:knowledge -- --database \
  --pack data/knowledge/shopping-en-governed-v1.json \
  --expected-fingerprint CURRENT_FINGERPRINT

npm run import:knowledge -- --database --apply \
  --pack data/knowledge/shopping-en-governed-v1.json \
  --expected-fingerprint CURRENT_FINGERPRINT
```

Export the returned inactive release UUID and evaluate its actual archived corpus with the intended runtime. The local candidate's parent UUID differs from production's parent UUID; do not copy its identity as a production candidate. Rebase against the actual production release and use its returned UUID.

Production promotion is **not cleared** by this report: the exact archived-corpus release gate and the 15 order-route flags identified in Phase 0 still need adjudication before a new production promotion. Do not manufacture passing evaluation evidence. Shared language rollout must coordinate all four demos and the matching Node/Python bundles. `deploy/aws-deploy/deploy.sh` does not automatically publish a new knowledge JSON file; it deploys a validated packaged release. Retain the previous compatible bundle and use the runbook's explicit rollback workflow.

Evidence, the frozen candidate runtime, replay, performance sample, and verification manifest are in `output/enterprise-knowledge-phase1-20261010/`. Source seed: `ai-service/app/commerce_language_engine/data/knowledge/shopping-en-governed-v1.json`.
