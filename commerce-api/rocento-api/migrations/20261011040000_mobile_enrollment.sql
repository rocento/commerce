-- Owner-approved internal installations; no embedded bootstrap secret or bundle-ID authentication.
CREATE TABLE mobile.device_invitations (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 identity_id uuid NOT NULL REFERENCES mobile.app_identities(id),
 created_by uuid NOT NULL REFERENCES admin_iam.admin_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '15 minutes',
 used_at timestamptz,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '15 minutes')
);
CREATE TABLE mobile.devices (
 id uuid PRIMARY KEY,
 identity_id uuid NOT NULL REFERENCES mobile.app_identities(id),
 token_hash text UNIQUE NOT NULL CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '30 days',
 revoked_at timestamptz,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '30 days')
);
ALTER TABLE mobile.app_sessions ADD COLUMN device_id uuid REFERENCES mobile.devices(id);
CREATE INDEX mobile_sessions_device ON mobile.app_sessions(device_id);
CREATE INDEX mobile_devices_identity ON mobile.devices(identity_id,created_at DESC);
