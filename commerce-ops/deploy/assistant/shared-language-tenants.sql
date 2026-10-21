-- Runtime logins share immutable language knowledge, not session ownership.
CREATE TABLE IF NOT EXISTS context.tenant_logins (
 role_name name PRIMARY KEY, tenant_id uuid NOT NULL, store_name text NOT NULL
);
REVOKE ALL ON context.tenant_logins FROM PUBLIC, ai_language_runtime;
CREATE OR REPLACE FUNCTION context.login_tenant() RETURNS uuid
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT tenant_id FROM context.tenant_logins WHERE role_name=session_user
$$;
REVOKE ALL ON FUNCTION context.login_tenant() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION context.login_tenant() TO ai_language_runtime;
ALTER TABLE context.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE context.sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS session_login_owner ON context.sessions;
CREATE POLICY session_login_owner ON context.sessions
 USING (tenant_id=context.login_tenant()) WITH CHECK (tenant_id=context.login_tenant());
DO $$ DECLARE item record; relation record; BEGIN
 FOR item IN SELECT nspname FROM pg_namespace WHERE nspname NOT IN ('pg_catalog','information_schema','migration_archive') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%' LOOP
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO ai_language_runtime',item.nspname);
  FOR relation IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname=item.nspname AND c.relkind IN ('r','p','v','m','f')
   AND NOT (n.nspname='resolution' AND c.relname IN ('feedback','feedback_reviews','feedback_queue'))
   AND NOT (n.nspname='evaluation' AND c.relname IN ('datasets','cases','dataset_runs','case_results'))
   AND NOT (n.nspname='knowledge' AND c.relname IN ('bulk_imports','bulk_chunks','bulk_concepts')) LOOP
   EXECUTE format('GRANT SELECT ON %I.%I TO ai_language_runtime',item.nspname,relation.relname);
  END LOOP;
 END LOOP;
END $$;
REVOKE ALL ON context.tenant_logins FROM ai_language_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON context.sessions TO ai_language_runtime;

-- Reviewed customer feedback and dataset contents are restricted to operators.
DO $$ DECLARE item text; BEGIN
 FOREACH item IN ARRAY ARRAY['resolution.feedback','resolution.feedback_reviews','resolution.feedback_queue','evaluation.datasets','evaluation.cases','evaluation.dataset_runs','evaluation.case_results','knowledge.bulk_imports','knowledge.bulk_chunks','knowledge.bulk_concepts'] LOOP
  IF to_regclass(item) IS NOT NULL THEN EXECUTE format('REVOKE ALL ON %s FROM ai_language_runtime',item); END IF;
 END LOOP;
END $$;
