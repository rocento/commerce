CREATE TABLE organizations(id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE reserved_slugs(slug text PRIMARY KEY);
INSERT INTO reserved_slugs VALUES ('admin'),('clients'),('onboarding'),('api'),('www'),('billing'),('support'),('ingress'),('mail'),('static'),('assets'),('security'),('status'),('docs'),('cdn'),('auth');
CREATE TABLE tenants(
 id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations(id), brand_display_name text NOT NULL,
 store_slug text NOT NULL UNIQUE CHECK(store_slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' AND store_slug NOT LIKE '%-admin'),
 plan_id text NOT NULL CHECK(plan_id IN ('LAUNCH','GROWTH','ENTERPRISE')),
 lifecycle_status text NOT NULL DEFAULT 'SLUG_RESERVED' CHECK(lifecycle_status IN ('SLUG_RESERVED','QUEUED','ALLOCATING','DEPLOYING','VALIDATING','ACTIVE','FAILED_REQUIRES_REVIEW','SUSPENDED')),
 slug_reserved_until timestamptz NOT NULL DEFAULT now()+interval '24 hours', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION reject_reserved_slug() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF EXISTS(SELECT 1 FROM reserved_slugs WHERE slug=NEW.store_slug) THEN RAISE EXCEPTION 'reserved slug' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER validate_slug BEFORE INSERT OR UPDATE OF store_slug ON tenants FOR EACH ROW EXECUTE FUNCTION reject_reserved_slug();
CREATE TABLE tenant_domains(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES tenants(id), hostname text NOT NULL UNIQUE,domain_type text NOT NULL CHECK(domain_type IN ('STOREFRONT','ADMIN')),route_status text NOT NULL DEFAULT 'RESERVED',UNIQUE(tenant_id,domain_type));
CREATE TABLE storefront_themes(id text PRIMARY KEY,name text NOT NULL,status text NOT NULL DEFAULT 'DISCOVERED' CHECK(status IN ('DISCOVERED','APPROVED','REVOKED')),demo_url text,artifact_digest text,version text,CHECK(status<>'APPROVED' OR (artifact_digest ~ '^sha256:[a-f0-9]{64}$' AND artifact_digest IS NOT NULL AND version IS NOT NULL AND demo_url IS NOT NULL)));
INSERT INTO storefront_themes(id,name) VALUES('pharmacy','Pharmacy & Skincare'),('jewelry','Jewelry'),('grocery','Grocery'),('electronics','Electronics');
CREATE TABLE outbox_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,aggregate_id uuid NOT NULL,subject text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz);
CREATE INDEX pending_outbox ON outbox_events(id) WHERE published_at IS NULL;
CREATE TABLE audit_events(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,actor_id text NOT NULL,action text NOT NULL,target_id uuid NOT NULL,occurred_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION immutable_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit events are append-only'; END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION immutable_audit();
