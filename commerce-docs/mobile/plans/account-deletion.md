# Automatic account deletion

Implemented in the Rust customer domain and gateway worker, Python assistant storage, and native iOS account screen. Local evidence: `commerce-output/2026-10-15-account-deletion`. This change has not been deployed or activated for any merchant.

## Merchant configuration

Each commerce installation has its own database and installation UUID. `GET/PUT /v1/admin/customer-retention` requires `customers.retention` (or super-administrator access). The backend supplies merchant identity. Configuration is currently through the authenticated API, not an admin form.

Example body — replace these illustrative values with the merchant's approved rules:

```json
{"legal_entity":"Merchant legal entity","jurisdictions":["Applicable jurisdiction"],"financial_days":365,"retain_contact":false,"retain_address":false}
```

No global retention duration is assumed. `financial_days` accepts 0–36525 days from the order's last update before erasure. It governs identifiable transaction snapshots; anonymous financial amounts/items are separate. Contact/address flags cannot be enabled with zero days. Every policy version records its approver and timestamp; each request pins the reviewed version. Subsequent policies cannot silently extend an existing request.

## Customer flow and API

The English/Arabic native account screen shows the policy and requires the current password plus explicit permanent-deletion confirmation. It saves an independent Keychain receipt before sending the request, without saving the password. The new `account-deletion` credential purpose uses the existing merchant/environment/origin-scoped derivation; customer refresh and Studio enrollment identities are unchanged.

`POST /v1/customer/account-deletion` accepts `request_id`, `policy_id`, a random 64-character hexadecimal `receipt_token`, `password` and `confirm`. It immediately revokes sessions, challenges and queued authentication notifications. Exact replay uses the stored receipt even after login revocation. `POST /v1/customer/account-deletion/status` requires only the request ID and receipt token. Tokens are hashed server-side and never placed in URLs; responses are not cacheable.

There is no grace period. Orders outside `cash_collected`/`cancelled` and unresolved `order_issue`/`payment_dispute` tickets defer erasure; unrelated support categories do not. The worker automatically resumes when obligations settle. `POST /v1/admin/account-deletions/{id}/hold` accepts `until` (future timestamp up to 365 days, or null to release) and `reason`, under the same retention permission. Holds cannot undo primary erasure.

## Erasure and retained records

Primary erasure removes addresses, reviews, wishlist, carts/quotes, delegated and assistant commerce receipts, customer memory, support content, device registrations and inbox data. Inventory holds are released and availability refreshed. Orders lose customer linkage, contact, address, gift message, coupon code and market context. Comments are deleted and free-text history/refund reasons replaced. An unusable customer tombstone prevents delayed writers recreating personal data.

The separate retained transaction table contains enumerated financial summary fields and only policy-enabled invoice contact/address fields. Delivery instructions and gift messages are excluded. `GET /v1/admin/account-deletions/{id}/records` requires the retention permission and excludes expired records. A worker purges expiry in batches; receipt status reports the latest retained expiry.

Engagement erasure removes live journey/marketing/inbox data and writes a tombstone. Assistant erasure removes conversations, dependent state and linked diagnostics, and blocks delayed customer writes. ClickHouse deletion waits for synchronous mutations and serializes with reporting snapshots. Event consumers suppress erased identities/carts. Durable checkpoints cover commerce, engagement, assistant and analytics; only all acknowledgements permit `complete`. Failures retry with backoff; `failed` means pending retry, not completed deletion.

## Rollout requirements and limits

Apply commerce and engagement migrations, assistant migration `012_account_deletion.sql`, and the assistant ingress route before releasing the native app. Shared assistant deployments must reapply `commerce-ops/deploy/assistant/shared-tenants.sql` in the same migration transaction, following the existing shared-database procedure. Configure approved merchant retention rules before enabling deletion.

The worker uses existing assistant signing and ClickHouse settings. Missing assistant configuration fails closed. Only an installation that has **never stored assistant customer data** may explicitly set `ACCOUNT_DELETION_ASSISTANT_MODE=never-used`; turning chat off does not qualify. Monitor pending/failed requests and `next_attempt_at` in `customers.deletion_requests`, plus overdue rows in `customers.retained_transactions`. Process health alone does not establish deletion progress.

Receipt/tombstone identifiers remain for idempotency and resurrection prevention. Existing backups, downloaded exports, historical logs and external mail/push providers are not rewritten by this worker. Their deletion/expiry schedules remain merchant release requirements. Replay the deletion ledger and purge expired retained data before reopening traffic after backup restoration. Verify real ClickHouse/assistant-ingress integration, signed on-device deletion and restoration in the target environment; local tests do not establish those outcomes.

See [backend architecture](../../backend/architecture.md), [mobile commerce](../commerce.md), [build and release](../build-and-release.md), and [shared assistant operations](../../ai-service/shared-database-operations.md).
