BEGIN;

CREATE TABLE IF NOT EXISTS pending_clarification_sessions (
 tenant_id uuid NOT NULL,
 session_id uuid NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(context)='object'),
 pending_request text,
 expires_at timestamptz NOT NULL,
 cancelled_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,session_id),
 CHECK(pending_request IS NULL OR length(pending_request)<=4000)
);
CREATE INDEX IF NOT EXISTS pending_clarification_expiry_idx
 ON pending_clarification_sessions(expires_at) WHERE cancelled_at IS NULL;

COMMIT;
