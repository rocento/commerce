DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM tenants WHERE store_slug='ops') THEN
 RAISE EXCEPTION 'ops hostname already allocated; resolve before installing staff dashboard';
 END IF;
END $$;
INSERT INTO reserved_slugs(slug) VALUES('ops') ON CONFLICT DO NOTHING;
CREATE TABLE staff_members (
 account_id uuid PRIMARY KEY REFERENCES customer_accounts(id),
 role text NOT NULL CHECK(role IN ('OWNER','VIEWER')),
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE staff_sessions (
 token_hash text PRIMARY KEY,
 parent_token_hash text NOT NULL UNIQUE REFERENCES customer_sessions(token_hash) ON DELETE CASCADE,
 account_id uuid NOT NULL REFERENCES staff_members(account_id),
 expires_at timestamptz NOT NULL
);
ALTER TABLE tenants ADD COLUMN management_state text NOT NULL DEFAULT 'ENABLED'
 CHECK(management_state IN ('ENABLED','SUSPEND_REQUESTED','SUSPENDED','ARCHIVE_REQUESTED','ARCHIVED'));
ALTER TABLE tenants ADD COLUMN archived_at timestamptz;
CREATE TABLE tenant_control_commands (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 action text NOT NULL CHECK(action IN ('SUSPEND','ARCHIVE')),
 requested_by uuid NOT NULL REFERENCES staff_members(account_id),
 reason text NOT NULL CHECK(length(reason) BETWEEN 3 AND 1000),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','APPLYING','APPLIED','FAILED')),
 error_code text,
 requested_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz
);
CREATE UNIQUE INDEX one_pending_tenant_control ON tenant_control_commands(tenant_id) WHERE status IN ('PENDING','APPLYING');
