CREATE TABLE IF NOT EXISTS assistant.deleted_customers(tenant_id uuid NOT NULL,customer_id uuid NOT NULL,PRIMARY KEY(tenant_id,customer_id));
CREATE TABLE IF NOT EXISTS assistant.customer_requests(tenant_id uuid NOT NULL,customer_id uuid NOT NULL,request_id uuid NOT NULL,PRIMARY KEY(tenant_id,request_id));
CREATE TABLE IF NOT EXISTS assistant.deleted_requests(tenant_id uuid NOT NULL,request_id uuid NOT NULL,PRIMARY KEY(tenant_id,request_id));
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['deleted_customers','customer_requests','deleted_requests'] LOOP
  EXECUTE format('ALTER TABLE assistant.%I ENABLE ROW LEVEL SECURITY',target);
  EXECUTE format('ALTER TABLE assistant.%I FORCE ROW LEVEL SECURITY',target);
  EXECUTE format('DROP POLICY IF EXISTS owner ON assistant.%I',target);
  EXECUTE format('DROP POLICY IF EXISTS tenant ON assistant.%I',target);
  EXECUTE format('CREATE POLICY tenant ON assistant.%I USING(tenant_id=(SELECT tenant_id FROM assistant.deployment WHERE singleton) AND tenant_id=current_setting(''assistant.tenant'',true)::uuid)',target);
  IF target IN ('deleted_customers','customer_requests') THEN
   EXECUTE format('CREATE POLICY owner ON assistant.%I AS RESTRICTIVE USING(customer_id=nullif(current_setting(''assistant.customer'',true),'''')::uuid)',target);
  END IF;
  EXECUTE format('GRANT SELECT,INSERT,DELETE ON assistant.%I TO ai_runtime',target);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION assistant.guard_deleted_customer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||NEW.customer_id::text,72));
 IF EXISTS(SELECT 1 FROM assistant.deleted_customers WHERE tenant_id=NEW.tenant_id AND customer_id=NEW.customer_id) THEN
  RAISE EXCEPTION 'Account unavailable';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS deleted_customer ON assistant.conversations;
CREATE TRIGGER deleted_customer BEFORE INSERT OR UPDATE ON assistant.conversations FOR EACH ROW EXECUTE FUNCTION assistant.guard_deleted_customer();
DROP TRIGGER IF EXISTS deleted_request_owner ON assistant.customer_requests;
CREATE TRIGGER deleted_request_owner BEFORE INSERT ON assistant.customer_requests FOR EACH ROW EXECUTE FUNCTION assistant.guard_deleted_customer();
CREATE OR REPLACE FUNCTION assistant.guard_deleted_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended(NEW.tenant_id::text||NEW.request_id::text,73));
 IF EXISTS(SELECT 1 FROM assistant.deleted_requests WHERE tenant_id=NEW.tenant_id AND request_id=NEW.request_id) THEN RETURN NULL; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS deleted_metric ON assistant.metrics;
CREATE TRIGGER deleted_metric BEFORE INSERT OR UPDATE ON assistant.metrics FOR EACH ROW EXECUTE FUNCTION assistant.guard_deleted_request();
DROP TRIGGER IF EXISTS deleted_tracking ON assistant.tracking_reports;
CREATE TRIGGER deleted_tracking BEFORE INSERT OR UPDATE ON assistant.tracking_reports FOR EACH ROW EXECUTE FUNCTION assistant.guard_deleted_request();
