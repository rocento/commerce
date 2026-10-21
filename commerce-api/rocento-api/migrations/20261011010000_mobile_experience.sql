-- Mobile control-plane data. Commerce data remains installation-isolated.
CREATE SCHEMA mobile;
CREATE TABLE mobile.merchants (
 id uuid PRIMARY KEY, name text NOT NULL,
 active boolean NOT NULL DEFAULT true,
 entitlements jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(entitlements)='object')
);
-- Membership is mandatory, including for installation super administrators.
CREATE TABLE mobile.memberships (
 merchant_id uuid NOT NULL REFERENCES mobile.merchants(id),
 admin_id uuid NOT NULL REFERENCES admin_iam.admin_users(id),
 role text NOT NULL CHECK(role IN ('owner','designer','operator','release_admin')),
 PRIMARY KEY(merchant_id,admin_id)
);
CREATE TABLE mobile.assets (
 id uuid PRIMARY KEY, merchant_id uuid NOT NULL REFERENCES mobile.merchants(id),
 url text NOT NULL CHECK(url ~ '^https://[^/[:space:]]+/'),
 kind text NOT NULL CHECK(kind IN ('image','icon','splash')),
 verified boolean NOT NULL DEFAULT false,
 checksum text NOT NULL CHECK(checksum ~ '^[0-9a-f]{64}$'),
 UNIQUE(merchant_id,id)
);
-- Trusted onboarding binds immutable native identity to one merchant/environment.
CREATE TABLE mobile.app_identities (
 id uuid PRIMARY KEY, merchant_id uuid NOT NULL REFERENCES mobile.merchants(id),
 environment text NOT NULL CHECK(environment IN ('staging','production')),
 platform text NOT NULL CHECK(platform IN ('ios','android')),
 identifier text NOT NULL, store_account_ref text NOT NULL,
 active boolean NOT NULL DEFAULT true,
 UNIQUE(platform,identifier), UNIQUE(merchant_id,environment,platform)
);
-- A trusted enrollment/attestation service provisions short-lived sessions.
-- No shared app secret, bundle-ID authentication or public token mint endpoint.
CREATE TABLE mobile.app_sessions (
 token_hash text PRIMARY KEY CHECK(token_hash ~ '^[0-9a-f]{64}$'),
 identity_id uuid NOT NULL REFERENCES mobile.app_identities(id),
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '1 hour')
);
CREATE INDEX mobile_sessions_expiry ON mobile.app_sessions(expires_at);
CREATE TABLE mobile.config_drafts (
 merchant_id uuid NOT NULL REFERENCES mobile.merchants(id),
 environment text NOT NULL CHECK(environment IN ('staging','production')),
 revision bigint NOT NULL CHECK(revision>0), config jsonb NOT NULL,
 updated_by uuid NOT NULL REFERENCES admin_iam.admin_users(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(merchant_id,environment)
);
CREATE TABLE mobile.config_versions (
 merchant_id uuid NOT NULL REFERENCES mobile.merchants(id),
 environment text NOT NULL CHECK(environment IN ('staging','production')),
 version bigint NOT NULL CHECK(version BETWEEN 1 AND 2147483647),
 config jsonb NOT NULL, checksum text NOT NULL CHECK(checksum ~ '^[0-9a-f]{64}$'),
 schema_version text NOT NULL,
 published_by uuid NOT NULL REFERENCES admin_iam.admin_users(id),
 published_at timestamptz NOT NULL DEFAULT now(), rollback_target bigint,
 PRIMARY KEY(merchant_id,environment,version),
 FOREIGN KEY(merchant_id,environment,rollback_target) REFERENCES mobile.config_versions(merchant_id,environment,version),
 CHECK(config->>'tenantId'=merchant_id::text),
 CHECK((config->>'configVersion')::bigint=version)
);
CREATE TABLE mobile.app_builds (
 id uuid PRIMARY KEY, merchant_id uuid NOT NULL REFERENCES mobile.merchants(id),
 environment text NOT NULL CHECK(environment IN ('staging','production')),
 platform text NOT NULL CHECK(platform IN ('ios','android')),
 build_number bigint NOT NULL CHECK(build_number>0),
 source_commit text NOT NULL CHECK(source_commit ~ '^[0-9a-f]{40}$'),
 manifest jsonb NOT NULL, manifest_checksum text NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','building','completed','failed')),
 created_by uuid NOT NULL REFERENCES admin_iam.admin_users(id),
 created_at timestamptz NOT NULL DEFAULT now(), artifact_ref text,
 UNIQUE(merchant_id,environment,platform,build_number)
);
CREATE TABLE mobile.idempotency (
 merchant_id uuid NOT NULL REFERENCES mobile.merchants(id),
 environment text NOT NULL CHECK(environment IN ('staging','production')),
 key text NOT NULL, request_checksum text NOT NULL, response jsonb NOT NULL,
 PRIMARY KEY(merchant_id,environment,key)
);
CREATE TABLE mobile.audit_events (
 id uuid PRIMARY KEY, merchant_id uuid NOT NULL REFERENCES mobile.merchants(id),
 environment text NOT NULL, actor_id uuid NOT NULL REFERENCES admin_iam.admin_users(id),
 action text NOT NULL, details jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mobile_audit_merchant ON mobile.audit_events(merchant_id,created_at DESC);
-- Append-only publication history is enforced even outside application code.
CREATE FUNCTION mobile.reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Mobile history is immutable'; END $$;
CREATE TRIGGER mobile_versions_immutable BEFORE UPDATE OR DELETE ON mobile.config_versions
 FOR EACH ROW EXECUTE FUNCTION mobile.reject_history_mutation();
CREATE TRIGGER mobile_audit_immutable BEFORE UPDATE OR DELETE ON mobile.audit_events
 FOR EACH ROW EXECUTE FUNCTION mobile.reject_history_mutation();
