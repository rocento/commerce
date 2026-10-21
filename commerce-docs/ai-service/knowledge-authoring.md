# Reviewed knowledge draft authoring

The operator tools use existing immutable release tables. They do not edit published knowledge rows or activate a release.

## Search, inspect and compare

From `commerce-assistant-platform/app/commerce_language_engine`:

```sh
node scripts/knowledge-catalog.ts search --release-id RELEASE_UUID --query teacher --kind person --limit 25
node scripts/knowledge-catalog.ts imports --limit 20
node scripts/knowledge-catalog.ts diff --release-id RELEASE_UUID --pack reviewed-next-pack.json
```

Set an explicit operator `DATABASE_URL` through your normal secret mechanism. Search also accepts `--dictionary FILE` instead of a release ID for offline inspection. The search output includes applicable rules and provenance; import inspection includes committed progress.

## Add, retire or replace aliases in a draft

Create a draft using the existing `scripts/release.ts draft-new` command and its reviewed dictionary/corpus inputs. Prepare a JSON edit request:

```json
{
  "schemaVersion": 1,
  "expectedPackSha256": "CURRENT_CANONICAL_PACK_SHA256",
  "nextRevision": 13,
  "actor": "operator-name",
  "reason": "Reviewed alias correction",
  "source": "review packet or source reference",
  "reviewer": "reviewer-name",
  "reviewMethod": "human",
  "reviewedAt": "2026-10-10T00:00:00Z",
  "edits": [{"conceptId": "person.teacher", "add": ["schoolteacher"], "remove": ["tutor"]}]
}
```

This is a syntax example, not a recommendation to retire “tutor.” `nextRevision` must be exactly one greater than the draft's knowledge revision. Use `ai_assisted` when review was AI-assisted; do not claim human review without it.

Preview is the default:

```sh
node scripts/knowledge-author.ts --draft-id DRAFT_UUID --revision 1 --edits reviewed-edits.json
```

Apply the reviewed change to a new immutable draft revision:

```sh
node scripts/knowledge-author.ts --draft-id DRAFT_UUID --revision 1 --edits reviewed-edits.json --apply
```

- `add` adds an alias; `remove` retires an existing alias from the next pack; both together replace wording.
- Canonical terms and historical lexical rows are not deleted. Old releases retain their exact behavior and provenance.
- The expected pack hash prevents stale content edits. The draft revision lock allows one winner when operators edit concurrently; other writers must reload and review the current diff.
- Existing validators reject duplicate normalized meanings, undeclared ambiguity, invalid scope and stale review hashes before writing.
- The audit record retains actor, reviewer, reason, source, exact operations, old/new hashes and diff in `release.draft_changes`.
- Preview writes nothing. Apply appends `release.draft_revisions` and `release.draft_changes`; it does not change `release.channels`.

Inspect in DBeaver:

```sql
SELECT draft_id, revision, change_key, kind, payload
FROM release.draft_changes
WHERE draft_id = 'DRAFT_UUID'::uuid
ORDER BY revision;
```

The existing draft-freeze, candidate evaluation and promotion gates still apply. The new tool does not bypass them.

## Current limits

This first authoring increment edits aliases on existing concepts. New concepts and rules use the existing reviewed whole-pack/draft workflows and resumable importer. Concept merges, canonical renaming, broader rule editors, automated dependency-cycle checks and richer rejected-row recovery remain on the enterprise plan. Existing bulk validation rejects an invalid bundle; this release does not add per-row rejection quarantine.
