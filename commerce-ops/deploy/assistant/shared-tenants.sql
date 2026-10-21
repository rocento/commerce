-- Opt-in shared assistant database. Run after the ordinary schema migrations,
-- in the same transaction when upgrading an already shared installation.
-- Login mappings are operator-owned. Session settings cannot change ownership.
CREATE TABLE IF NOT EXISTS assistant.tenant_logins (
 role_name name PRIMARY KEY,
 tenant_id uuid NOT NULL,
 store_name text NOT NULL
);
REVOKE ALL ON assistant.tenant_logins FROM PUBLIC, ai_runtime, ai_knowledge_writer;
CREATE OR REPLACE FUNCTION assistant.login_tenant() RETURNS uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT tenant_id FROM assistant.tenant_logins WHERE role_name=session_user
$$;
REVOKE ALL ON FUNCTION assistant.login_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant.login_tenant() TO ai_runtime, ai_knowledge_writer;

DO $$
DECLARE item record; policy record; predicate text;
BEGIN
 FOR item IN
  SELECT c.relname,
   EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='customer_id' AND NOT a.attisdropped) AS customer
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='assistant' AND c.relkind='r'
    AND c.relname NOT IN ('deployment','tenant_logins',
      'domain_releases','domain_sources','domain_profiles','domain_release_revocations')
 LOOP
  predicate := 'tenant_id=assistant.login_tenant() AND tenant_id=nullif(current_setting(''assistant.tenant'',true),'''')::uuid';
  IF item.customer THEN
   predicate := predicate || ' AND customer_id=nullif(current_setting(''assistant.customer'',true),'''')::uuid';
  END IF;
  FOR policy IN SELECT policyname FROM pg_policies WHERE schemaname='assistant' AND tablename=item.relname LOOP
   EXECUTE format('DROP POLICY %I ON assistant.%I',policy.policyname,item.relname);
  END LOOP;
  EXECUTE format('ALTER TABLE assistant.%I ENABLE ROW LEVEL SECURITY',item.relname);
  EXECUTE format('ALTER TABLE assistant.%I FORCE ROW LEVEL SECURITY',item.relname);
  EXECUTE format('CREATE POLICY tenant_login_owner ON assistant.%I USING (%s) WITH CHECK (%s)',item.relname,predicate,predicate);
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION assistant.purge_expired(target uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF target IS NULL OR target IS DISTINCT FROM assistant.login_tenant()
    OR target IS DISTINCT FROM nullif(current_setting('assistant.tenant',true),'')::uuid THEN
  RAISE EXCEPTION 'tenant mismatch';
 END IF;
 DELETE FROM assistant.conversations WHERE tenant_id=target AND created_at<now()-interval '30 days';
 DELETE FROM assistant.metrics WHERE tenant_id=target AND created_at<now()-interval '90 days';
 DELETE FROM assistant.tracking_reports WHERE tenant_id=target AND created_at<now()-interval '7 days';
END $$;
REVOKE ALL ON FUNCTION assistant.purge_expired(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant.purge_expired(uuid) TO ai_runtime;
-- These roles carry privileges only; each demo authenticates with its own login.
ALTER ROLE ai_runtime NOLOGIN;
ALTER ROLE ai_knowledge_writer NOLOGIN;
