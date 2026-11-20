-- A local transactional outbox subscriber. published_at remains reserved for
-- external transport delivery; consuming an event here never claims NATS delivery.
CREATE TABLE provisioning_event_receipts (
 event_id bigint PRIMARY KEY REFERENCES outbox_events(id),
 consumed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE provisioning_jobs (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id),
 payment_request_id uuid NOT NULL UNIQUE REFERENCES payment_requests(id),
 theme_id text NOT NULL REFERENCES storefront_themes(id),
 release_version text,
 artifact_digest text,
 status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','RUNNING','RETRY','BLOCKED','SUCCEEDED','FAILED')),
 step text NOT NULL DEFAULT 'RELEASE' CHECK(step IN ('RELEASE','ALLOCATE','DEPLOY','VALIDATE','DONE')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 lease_token uuid,
 lease_until timestamptz,
 next_run_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_error text,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 CHECK ((status='RUNNING')=(lease_token IS NOT NULL AND lease_until IS NOT NULL)),
 CHECK ((status='SUCCEEDED')=(step='DONE' AND completed_at IS NOT NULL)),
 CHECK ((release_version IS NULL)=(artifact_digest IS NULL))
);
CREATE INDEX provisioning_jobs_due ON provisioning_jobs(next_run_at) WHERE status IN ('QUEUED','RETRY','BLOCKED');
CREATE TABLE provisioning_steps (
 job_id uuid NOT NULL REFERENCES provisioning_jobs(id),
 step text NOT NULL CHECK(step IN ('RELEASE','ALLOCATE','DEPLOY','VALIDATE')),
 evidence jsonb NOT NULL,
 completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(job_id,step)
);
CREATE TABLE provisioning_attempts (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 job_id uuid NOT NULL REFERENCES provisioning_jobs(id),
 step text NOT NULL,
 lease_token uuid NOT NULL,
 outcome text NOT NULL,
 error_code text,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER provisioning_attempts_immutable BEFORE UPDATE OR DELETE ON provisioning_attempts
 FOR EACH ROW EXECUTE FUNCTION immutable_audit();
CREATE TRIGGER provisioning_steps_immutable BEFORE UPDATE OR DELETE ON provisioning_steps
 FOR EACH ROW EXECUTE FUNCTION immutable_audit();
ALTER TABLE tenants ADD COLUMN activated_at timestamptz;
ALTER TABLE billing_entitlements ADD COLUMN starts_at timestamptz;
ALTER TABLE billing_entitlements ADD COLUMN ends_at timestamptz;
ALTER TABLE billing_entitlements ADD CHECK ((starts_at IS NULL AND ends_at IS NULL) OR
 (starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at>starts_at));
