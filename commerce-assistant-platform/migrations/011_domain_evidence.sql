-- Structured requirement releases are shared; product attestations and release
-- bindings are tenant-owned. No source documents or catalog offers are copied.
CREATE TABLE IF NOT EXISTS assistant.domain_releases (
 fingerprint text PRIMARY KEY CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 revision integer NOT NULL CHECK(revision>0),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object' AND octet_length(manifest::text)<=524288),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS assistant.domain_sources (
 release_fingerprint text NOT NULL REFERENCES assistant.domain_releases(fingerprint),
 id text NOT NULL, metadata jsonb NOT NULL CHECK(octet_length(metadata::text)<=8192),
 PRIMARY KEY(release_fingerprint,id)
);
CREATE TABLE IF NOT EXISTS assistant.domain_profiles (
 release_fingerprint text NOT NULL REFERENCES assistant.domain_releases(fingerprint),
 id text NOT NULL, metadata jsonb NOT NULL CHECK(octet_length(metadata::text)<=32768),
 PRIMARY KEY(release_fingerprint,id)
);
CREATE TABLE IF NOT EXISTS assistant.domain_bindings (
 tenant_id uuid PRIMARY KEY,
 release_fingerprint text NOT NULL REFERENCES assistant.domain_releases(fingerprint),
 activated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS assistant.product_evidence (
 tenant_id uuid NOT NULL, product_id uuid NOT NULL, id uuid NOT NULL,
 metadata jsonb NOT NULL CHECK(octet_length(metadata::text)<=8192),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,id),
 CHECK(metadata->>'tenant_id'=tenant_id::text AND metadata->>'product_id'=product_id::text AND metadata->>'id'=id::text)
);
CREATE INDEX IF NOT EXISTS product_evidence_lookup ON assistant.product_evidence(tenant_id,product_id);
CREATE TABLE IF NOT EXISTS assistant.product_evidence_revocations (
 tenant_id uuid NOT NULL, evidence_id uuid NOT NULL, reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
 revoked_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,evidence_id),
 FOREIGN KEY(tenant_id,evidence_id) REFERENCES assistant.product_evidence(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS assistant.domain_release_revocations (
 fingerprint text PRIMARY KEY REFERENCES assistant.domain_releases(fingerprint),
 reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500), revoked_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION assistant.immutable_domain_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 RAISE EXCEPTION 'Domain evidence is immutable; publish a new release or append a revocation';
END $$;
REVOKE ALL ON FUNCTION assistant.immutable_domain_evidence() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['domain_releases','domain_sources','domain_profiles','product_evidence','product_evidence_revocations','domain_release_revocations'] LOOP
  EXECUTE format('DROP TRIGGER IF EXISTS immutable_domain_evidence ON assistant.%I',t);
  EXECUTE format('CREATE TRIGGER immutable_domain_evidence BEFORE UPDATE OR DELETE ON assistant.%I FOR EACH ROW EXECUTE FUNCTION assistant.immutable_domain_evidence()',t);
 END LOOP;
END $$;

DO $$ DECLARE t text; predicate text; BEGIN
 IF to_regprocedure('assistant.login_tenant()') IS NOT NULL THEN
  predicate := 'tenant_id=assistant.login_tenant() AND tenant_id=nullif(current_setting(''assistant.tenant'',true),'''')::uuid';
 ELSE
  predicate := 'tenant_id=(SELECT tenant_id FROM assistant.deployment WHERE singleton) AND tenant_id=nullif(current_setting(''assistant.tenant'',true),'''')::uuid';
 END IF;
 FOREACH t IN ARRAY ARRAY['domain_bindings','product_evidence','product_evidence_revocations'] LOOP
  EXECUTE format('ALTER TABLE assistant.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE assistant.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('DROP POLICY IF EXISTS domain_tenant ON assistant.%I',t);
  EXECUTE format('CREATE POLICY domain_tenant ON assistant.%I USING (%s) WITH CHECK (%s)',t,predicate,predicate);
 END LOOP;
END $$;
REVOKE ALL ON assistant.domain_releases,assistant.domain_sources,assistant.domain_profiles,assistant.domain_bindings,
 assistant.product_evidence,assistant.product_evidence_revocations,assistant.domain_release_revocations FROM PUBLIC,ai_runtime,ai_knowledge_writer;
GRANT SELECT ON assistant.domain_releases,assistant.domain_sources,assistant.domain_profiles,assistant.domain_bindings,
 assistant.product_evidence,assistant.product_evidence_revocations,assistant.domain_release_revocations TO ai_runtime,ai_knowledge_writer;
-- Knowledge writers may attest/revoke their own tenant's facts, never publish
-- shared requirement releases or activate a release. Publication is operator-only.
GRANT INSERT ON assistant.product_evidence,assistant.product_evidence_revocations TO ai_knowledge_writer;
