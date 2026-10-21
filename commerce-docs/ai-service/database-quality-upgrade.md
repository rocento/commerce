# Database quality upgrade

Language migrations 025–027 retire empty legacy entity tables, consolidate evaluation reporting, and add reviewed regression datasets. Assistant migration 010 retires the empty reserved `assistant.documents` table. Retirement refuses nonempty legacy tables and uses no CASCADE. Historical migrations/checksums are unchanged. `assistant.deployment` remains required by readiness and legacy installation policies.

## Evaluation reporting

`release.evaluations` is the authoritative source of new release evidence. `evaluation.results` is now a reporting view with text IDs (`release:<uuid>` or `legacy:<number>`). Older reports remain in immutable `evaluation.legacy_results`; no historical test identity is invented. Older operator images may insert an exact duplicate of existing release evidence through the compatibility view without storing a second report. Other inserts are rejected. Sort reports by `created_at`, not the reporting ID.

`release.production_status` shows the current production release and latest activation. Normalized authoring tables are not guaranteed to match the active artifact. Use the published artifact for inspection of actual runtime rules. The migration does not fabricate projection provenance.

## Reviewed datasets

Use operator DATABASE_URL credentials from the existing release workflow. Customer-facing runtime accounts cannot access dataset case contents or feedback. No automatic customer-message collection is enabled by this change. Keep any operator input files containing customer information on the production host with restricted access; redact unnecessary identifiers before review.

From `commerce-assistant-platform/app/commerce_language_engine`:

```sh
npm run quality -- dataset-validate --file reviewed.json
npm run quality -- dataset-import --file reviewed.json
npm run quality -- dataset-inspect --dataset-id DATASET_UUID
npm run release:evaluate -- --release-id CANDIDATE_UUID --dataset-id DATASET_UUID --report evaluation.json
```

Input example (a synthetic example, not a claim of customer accuracy):

```json
{
  "code": "shopping-regression",
  "revision": 1,
  "reviewedBy": "operator-name",
  "cases": [{
    "key": "red-shoes-search",
    "text": "find red shoes",
    "language": "en",
    "industry": "CORE",
    "expected": {
      "intent": "PRODUCT_SEARCH",
      "status": "RESOLVED",
      "entities": {"color": "red"},
      "actions": [],
      "missing": []
    }
  }]
}
```

A dataset revision is immutable; change its revision when changing expectations. Unknown fields, duplicate keys and unsupported languages are rejected. Context can be supplied with each case. Intent and status must match exactly; specified entity keys must match exactly; supplied action arrays and missing-slot arrays must match exactly. Industry is a reporting label; it does not silently change runtime context. English is the currently supported language.

The reviewed dataset adds to the archived-corpus checks. Both must pass to produce passing evidence when `--dataset-id` is supplied. Omitting the option retains the existing archived-corpus gate; dataset selection is explicit, not an automatically inferred quality policy. A failed evaluation is still recorded and returns a failing command exit status. Inspect individual failures in `evaluation.case_results` joined to `evaluation.cases`; the shared runtime-visible report contains only reviewed dataset counts and identity. Datasets and their case membership, evaluation runs, and case results are immutable; case results are committed atomically with release evidence. No promotion occurs during evaluation.

## Feedback to regression cases

Capture an operator-selected observation:

```sh
npm run quality -- feedback-capture --file feedback.json
npm run quality -- feedback-review --file review.json
```

Capture input fields: `tenantId`, `requestId`, `releaseId`, `engineVersion`, `predictedIntent`, `status`, and `observedCase` using the case format above. The request identity is unique per tenant, and the immutable release must exist. The observation's expectation is a proposal until explicitly reviewed.

Review fields: `feedbackId` (integer string), `decision` (`approved` or `rejected`), `reviewer`, `reason`, and `correctedCase` for approvals. Reviews are immutable; do not overwrite an earlier decision. A rejected review must omit `correctedCase`.

To add approved feedback to a new dataset revision, copy its exact `correctedCase` and add `sourceFeedbackId`. Database constraints reject an unreviewed/rejected feedback reference or a case differing from its approved correction. `resolution.feedback_queue` shows pending and completed reviews. Operators must validate/redact proposed corrections; customer input cannot publish a rule, activate a release, or approve itself.

## Deferred work

Archive relocation, corpus deduplication, and replacement of the legacy assistant deployment singleton remain separate changes. The newly introduced quality tables are empty until operators import real reviewed datasets or feedback. This upgrade does not claim that the existing production baseline passed a new reviewed evaluation.
