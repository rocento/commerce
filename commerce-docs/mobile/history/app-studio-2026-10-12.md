# App Studio verification — 2026-10-11 and 2026-10-12

Historical deployment and local verification checkpoints, including blocked checks. Use the [current Studio guide](../app-studio.md), [mobile status](../README.md) and [release plan](../plans/native-preview-and-release.md) for current behavior and remaining gates.

## Local verification — 2026-10-11

Checks recorded locally on 2026-10-11:

- 11 frontend model/contract tests cover all section types, validation, tenant binding, roles, reorder and diff semantics.
- Chromium workflows cover separate login, color/layout edits, Arabic/dark previews, direct production approval, designer/operator access, conflicts, edits during autosave, retained publish retry keys, rollback, uploads and 390 px layouts.
- Eight PostgreSQL integration tests cover the existing publish/rollback/cache/RBAC contract plus membership discovery, scoped asset/audit history, PNG sanitization, an actual upload/read through an S3 HTTP fixture, and publishing that uploaded asset.
- Real disposable Nginx tests verify separate root/deep-link bundles, request rewriting and denial of core and encoded-path API access. Existing deployment and canonical contract tests also run.

Reproduce focused checks from the repository root:



## Initial deployment checkpoint — 2026-10-11

The main CI workflow includes standalone browser checks and contract-generation drift detection. Production login, private asset upload/read, tenant isolation, direct publication, idempotency, conflicts and immutable rollback are also checked in an isolated live verification workspace. Verification merchants are deactivated afterward; This was the 2026-10-11 checkpoint. Later [commerce records](commerce-2026-10-12.md) establish internal enrollment and published native configuration; signed physical-device acceptance and store submission remain pending.

## Runtime 1.1 rollout — 2026-10-12

The coordinated gateway/Studio deployment is complete.
A published Home → location change was visually verified on iOS and Android in
v4, then the saved final design was published as v5. Fresh native v5 checks pass.
See the [native deployment evidence](commerce-2026-10-12.md#runtime-11-deployment-and-live-design-reflection--2026-10-12).

## Order preview checks — 2026-10-12

Verified with TypeScript and 16 browser checks covering both platforms, Arabic dark compact layout, refresh without progression, persisted history, pickup/delivery progression, cancellation/refunds, reorder, promotions and notification links.

## Preferences checks and blocked native verification — 2026-10-12

Validation evidence is in `output/mobile-native-preferences-20261012`. Six focused browser checks cover both platforms, Arabic at 320px, order links, refresh without status advancement, read state and preference persistence, independent device preferences, and zero customer/config writes. Initial native builds passed. Later full native verification encountered unrelated concurrent assistant-product `sku` compilation errors; iOS runtime-1.2 config tests also failed. An isolated iOS UI regression test was added but could not execute through those compilation errors. These checks must be rerun before native distribution.

Follow-up validation: the latest shared-source TypeScript check is also blocked by concurrent `deals` navigation enum mismatches in `mobile-validation.ts`. The isolated tested preview bundle remains in the evidence directory; no deployment was performed in this task. Android core task completed successfully, but its shared XML output was overwritten by another run afterward; use the task-specific build log rather than those XML counts.

## Header preview checks — 2026-10-12

All 16 focused browser checks passed against the frozen bundle, including header/search/address behavior, Deals pagination, 320px Arabic layout, notification/settings persistence and order links. The app TypeScript check also passed after the generated Deals types settled. `output/mobile-native-preferences-20261012/header-freeze.json` records source hashes and validation scope. Source was handed to the authorized release-coordination chat; this chat did not deploy or install.
