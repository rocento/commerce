-- Development inbox delivery. Payloads are sensitive and cleared at terminal states.
CREATE TABLE platform.notification_jobs (
 id uuid PRIMARY KEY,
 customer_id uuid REFERENCES customers.customers(id) ON DELETE CASCADE,
 purpose text NOT NULL,
 challenge_hash text,
 payload jsonb,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','expired','failed')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL,
 last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 CHECK ((status = 'pending') = (payload IS NOT NULL))
);
CREATE INDEX notification_jobs_pending ON platform.notification_jobs(available_at) WHERE status='pending';
