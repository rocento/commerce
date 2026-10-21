-- Short-lived operator diagnostics. Customer-scoped history remains separate.
CREATE TABLE IF NOT EXISTS assistant.tracking_reports (
 tenant_id uuid NOT NULL,
 request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 question_preview varchar(500) NOT NULL,
 report jsonb NOT NULL CHECK (octet_length(report::text) <= 1500000),
 PRIMARY KEY (tenant_id,request_id)
);
CREATE INDEX IF NOT EXISTS tracking_reports_window ON assistant.tracking_reports(tenant_id,created_at DESC);
ALTER TABLE assistant.tracking_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.tracking_reports FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tracking_reports_tenant ON assistant.tracking_reports;
CREATE POLICY tracking_reports_tenant ON assistant.tracking_reports
 USING(tenant_id=(SELECT tenant_id FROM assistant.deployment WHERE singleton)
       AND tenant_id=current_setting('assistant.tenant',true)::uuid)
 WITH CHECK(tenant_id=(SELECT tenant_id FROM assistant.deployment WHERE singleton)
       AND tenant_id=current_setting('assistant.tenant',true)::uuid);
GRANT SELECT,INSERT,DELETE ON assistant.tracking_reports TO ai_runtime;
CREATE OR REPLACE FUNCTION assistant.purge_expired(target uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,assistant AS $$
BEGIN
 IF target IS DISTINCT FROM current_setting('assistant.tenant',true)::uuid
    OR target IS DISTINCT FROM (SELECT tenant_id FROM assistant.deployment WHERE singleton) THEN
  RAISE EXCEPTION 'tenant mismatch';
 END IF;
 DELETE FROM assistant.conversations WHERE tenant_id=target AND created_at<now()-interval '30 days';
 DELETE FROM assistant.metrics WHERE tenant_id=target AND created_at<now()-interval '90 days';
 DELETE FROM assistant.tracking_reports WHERE tenant_id=target AND created_at<now()-interval '7 days';
END; $$;
REVOKE ALL ON FUNCTION assistant.purge_expired(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant.purge_expired(uuid) TO ai_runtime;
