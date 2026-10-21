-- Ephemeral draft access is separate from production enrollment and releases.
CREATE TABLE mobile.preview_sessions (
 id uuid PRIMARY KEY,
 merchant_id uuid NOT NULL REFERENCES mobile.merchants(id),
 environment text NOT NULL CHECK(environment IN ('staging','production')),
 created_by uuid NOT NULL REFERENCES admin_iam.admin_users(id),
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
 revoked_at timestamptz,
 delivered_revision bigint,
 delivered_checksum text,
 applied_revision bigint,
 applied_at timestamptz,
 CHECK(applied_revision IS NULL OR applied_revision <= delivered_revision)
);
CREATE INDEX preview_sessions_expiry ON mobile.preview_sessions(expires_at);
