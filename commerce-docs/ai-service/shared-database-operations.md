# Shared AI database operations

The four production demos share one PostgreSQL instance, `rocento-ai-shared-ai-postgres-1`, with two databases:

- `assistant`: conversations, turns, state, metrics and knowledge, partitioned logically by tenant UUID and protected by forced row-level security.
- `commerce_language`: one active language dictionary and its rules/vocabulary; pending sessions remain scoped to each demo's login.

Products, customers, orders and other commerce data remain in each demo's existing commerce database. Provider configuration, signing identities and commerce capability credentials also remain separate.

## Ownership and runtime permissions

Each demo authenticates as `ai_runtime_<store>` for assistant state and `language_<store>` for language data. Operator-owned login registries bind `session_user` to the tenant UUID. Changing a tenant session setting or switching to the inherited privilege role does not change this binding. Customer-owned assistant tables also require the matching customer context.

`ai_runtime` and `ai_language_runtime` are non-login privilege roles. Language consumers read dictionary tables and can manage only their tenant's pending sessions. They cannot migrate schemas or activate releases. The shared startup path checks every packaged migration checksum and the exact active artifact before accepting traffic; an outdated image fails instead of downgrading the dictionary.

The assistant's legacy singleton `deployment` row is retained for compatibility with existing migration/readiness checks. Authorization in shared mode uses `assistant.tenant_logins` and `assistant.login_tenant()`, not that singleton row. Always run assistant upgrades through `commerce-ops/scripts/local/conversations-setup.py`, which reapplies shared policies in the same transaction when the login registry exists.

Knowledge publishing uses a separate per-tenant `ai_knowledge_writer_<store>` identity. Provision its login, password and registry mapping explicitly for an authorized operator; runtime accounts retain read-only knowledge access.

## Deployment

`commerce-ops/compose/compose.ai-shared.yaml` owns the shared server and volume. `commerce-ops/deploy/ec2/server/ec2-compose.sh` enables `commerce-ops/deploy/ec2/shared-ai-consumer.yaml` only when a store's protected `<store>-shared-ai.env` exists. The overlay removes the old per-store database dependency and keeps the old service behind a legacy profile so ordinary deployments cannot recreate it.

Full and targeted deployment scripts call `commerce-ops/deploy/ec2/server/ec2-shared-ai-upgrade.sh` for shared migrations. Language migrations and explicit release operations use the protected `commerce-ops/deploy/ec2/shared-ai/language-owner.env` operator credentials; runtime credentials are never promoted. Shared language upgrades must target all stores. Do not use the legacy profile after consolidation.

On the production host, from its repository root (normally `/opt/rocento`), inspect the shared instance without exposing credentials:

```sh
docker ps --filter name=rocento-ai-shared-ai-postgres-1
docker exec rocento-ai-shared-ai-postgres-1 psql -U ai_owner -d assistant \
  -c 'SELECT store_name,tenant_id FROM assistant.tenant_logins ORDER BY store_name;'
```

## Migration and recovery

The operator-only `commerce-ops/scripts/maintenance/unify-ai-databases.py` has three explicit stages and holds the existing deployment lock:

1. `prepare`: preserve all eight source databases in restricted server-side backups; restore into the new shared server; compare every assistant row to restored backups; verify the active language artifact and tenant isolation. Consumers keep using the original databases.
2. `cutover`: stop assistant ingress, drain/stop both engines, repeat the backup and verified copy, enable consumer routing, start the engines and verify readiness. Ingress resumes only after successful checks. Before this commit point, failure restores routing to the original databases. After traffic resumes, rollback requires preserving/reconciling new shared writes; never replace the shared database with an older snapshot.
3. `cleanup`: require successful cutover evidence, retained backup files and healthy shared consumers; remove only the four old AI containers/volumes and the four `commerce_language` databases from commerce PostgreSQL instances. It does not delete commerce databases or backup archives.

Backups and migration reports stay under `/var/backups/rocento/ai-unification-*` on the production host with restrictive permissions. The most recent committed backup path is recorded in `/opt/rocento/deploy/ec2/shared-ai/cutover.json`. Reports contain aggregate counts and pass/fail results. Content comparisons and customer records stay on the server.

Differing language history/projection records are retained exactly in the operator-only `commerce_language.migration_archive.source_rows`, with their source store/table. They are archival evidence, not an activated runtime projection. Full original database dumps remain available as the authoritative reconstruction source.

Before cutover/cleanup, verify the intended release through the maintained [language release lifecycle](language-release-upgrade.md#promote-and-deploy), then check every running language consumer with its own runtime identity. From the repository root on the production host, this read-only check validates the packaged release against the active database and does not migrate or activate it:

```sh
for store in grocery jewelry electronics pharmacy; do
  bash commerce-ops/deploy/ec2/server/ec2-compose.sh "$store" exec -T commerce-language-engine \
    node scripts/deploy-start.ts --verify-only || exit 1
done
```

This verifies compatibility with the active release, not that it is the operator's intended candidate. Compare the active UUID, runtime and fingerprint with the frozen release manifest, check Python and gateway readiness for all four stores, and run the candidate's reviewed bounded semantic/contract checks before reopening ingress or removing old data. Record those results with the migration report. Runtime verification alone does not establish shopping-answer quality or authorize cleanup.

The former `output/live-deploy-language-rev4-20261009/verify-live.sh` is historical revision-4 evidence: its fingerprint, row counts and semantics are hard-coded. Do not adapt that archived script in place or use it as a current gate. New release evidence must retain its own reviewed expectations and identity.

See [DBeaver access](database-access.md) for connection settings.

## Language release promotion

Follow the [language release upgrade runbook](language-release-upgrade.md). Migration-only startup no longer imports or activates an image bundle. Stage/import and evaluate the exact candidate with operator credentials, explicitly promote it, then deploy its matching runtime images. Runtime startup only verifies the selected release; an old image cannot reactivate its archive.

For reviewed regression datasets, feedback review, consolidated evaluation reporting, and the forward-only retirement of empty legacy tables, see the [database quality upgrade](database-quality-upgrade.md). Reviewed case contents and feedback are operator-only; runtime grants explicitly exclude them. `release.production_status` identifies the active published artifact without implying that normalized authoring tables match it.
