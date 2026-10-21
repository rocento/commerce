# Journey and notification storage isolation

Production deployment uses three distinct storage paths:

- Commerce PostgreSQL remains authoritative for customers, sessions, catalog, orders, checkout and coupons.
- Engagement PostgreSQL stores browser journey rows, notification programs, publications, recipients, read states, grants, audits and durable processing jobs. It has its own volume and credentials per store.
- ClickHouse receives analytics asynchronously from the engagement worker. It is not the operational notification database.

`POST /v1/analytics/events` and product visits return HTTP 202 only after a durable enqueue. The worker records attributed journey events, forwards analytics and matches product campaigns outside the page request. Anonymous analytics remain anonymous. Product grants are deduplicated per recipient/publication. Expired or withdrawn campaigns cannot deliver when a delayed job is retried. The storefront polls briefly after a queued visit and also refreshes periodically.

The worker uses the same backend Docker image as the gateway and export worker. Each demo has independent engagement containers/data; no customer data is shared between stores. Its PostgreSQL container is limited to 512 MiB/0.5 CPU and the worker to 256 MiB/0.5 CPU. The worker processes one job at a time, with exponential retry and a failed-job state after ten attempts. Completed payloads are cleared immediately; completed queue entries are retained seven days for deduplication. Existing journey/notification retention is unchanged.

Authentication still checks live commerce sessions. Admin journey views and manual campaign evaluation still read authoritative order/customer facts, through a separate two-connection pool with a five-second statement timeout. The worker uses one commerce connection to refresh public product references and delivery geometry once per minute. Stale targeting projections fail closed. These limits reduce competition with checkout; the containers still share the EC2 host and disks, so this is not a claim of zero performance impact or a load-test result.

## Deployment and first cutover

Run the normal `commerce-ops/deploy/aws-deploy/deploy.sh`. Configuration generates and preserves a dedicated engagement password. Deployment starts engagement PostgreSQL, stops the old gateway/worker, then starts the new backend. The gateway creates the separate schema and copies historical journey and notification records in one destination transaction, verifies row counts, and records the source installation ID. UUIDs, guest cookies, read states and timestamps are retained. Source tables remain intact for recovery. A failed import rolls back; retrying a completed import does not duplicate records. A database belonging to another store is rejected.

The first cutover involves an API interruption while data is copied. Back up before deployment and allow an appropriate maintenance window for the size of the historical data. No demo reseeding is needed. Production requires `ENGAGEMENT_DATABASE_URL`; unavailable engagement storage never falls back to commerce writes. Local tests without that variable retain the legacy same-database mode.

After cutover, retained source tables are historical snapshots, not current notification data. Do not roll back to a pre-isolation binary: it would read the stale source copy. Recover the engagement volume or perform an explicit reverse migration during a maintenance window.

## Operations

Use `sudo bash commerce-ops/deploy/ec2/server/ec2-status.sh` for database/worker health. Health is unhealthy when the heartbeat is stale, the public projection is older than two minutes, a job has failed permanently, or pending work is older than five minutes.

From the repository on EC2, replace `grocery` with the relevant store:

```sh
sudo bash commerce-ops/deploy/ec2/server/ec2-compose.sh grocery exec -T engagement-worker engagement-worker --status
sudo bash commerce-ops/deploy/ec2/server/ec2-compose.sh grocery logs --tail 100 engagement-worker
# After fixing the underlying dependency failure:
sudo bash commerce-ops/deploy/ec2/server/ec2-compose.sh grocery exec -T engagement-worker engagement-worker --retry-failed
```

Back up the new database as well as commerce. For example, under a protected backup directory, with a restrictive umask:

```sh
umask 077
sudo bash commerce-ops/deploy/ec2/server/ec2-compose.sh grocery exec -T engagement-postgres pg_dump -U engagement -d engagement -Fc > grocery-engagement.dump
```

Check command success, verify the archive with `pg_restore --list`, and include it in the existing encrypted off-host backup/restore procedure. This change does not configure off-host backups. Retain the matching protected store environment file containing its credentials. Never delete the engagement volume during image cleanup. Notification audit outbox events are published from the isolated worker; they do not send external customer messages. Native inbox delivery requires no browser push permission and does not send email/SMS/OS push.
