CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS assistant;
CREATE TABLE IF NOT EXISTS assistant.conversations (
 tenant_id uuid NOT NULL, customer_id uuid NOT NULL, id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,customer_id,id)
);
CREATE TABLE IF NOT EXISTS assistant.turns (
 tenant_id uuid NOT NULL, customer_id uuid NOT NULL, conversation_id uuid NOT NULL,
 request_id uuid NOT NULL, question text NOT NULL, answer text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,customer_id,request_id),
 FOREIGN KEY(tenant_id,customer_id,conversation_id) REFERENCES assistant.conversations(tenant_id,customer_id,id) ON DELETE CASCADE,
 CHECK(length(question)<=4000 AND length(answer)<=8000)
);
CREATE TABLE IF NOT EXISTS assistant.metrics (
 tenant_id uuid NOT NULL, request_id uuid NOT NULL, outcome text NOT NULL,
 latency_ms integer NOT NULL, exported_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,request_id), CHECK(latency_ms>=0)
);
-- Projection storage is reserved until the approved embedding and area contracts are active.
CREATE TABLE IF NOT EXISTS assistant.documents (
 tenant_id uuid NOT NULL, id uuid NOT NULL, revision bigint NOT NULL,
 kind text NOT NULL CHECK(kind IN ('catalog','faq')), body text NOT NULL,
 embedding vector, deleted boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,id), CHECK(length(body)<=16000)
);
ALTER TABLE assistant.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant.turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.turns FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant.metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.metrics FORCE ROW LEVEL SECURITY;
ALTER TABLE assistant.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.documents FORCE ROW LEVEL SECURITY;
CREATE POLICY conversations_owner ON assistant.conversations USING(tenant_id=current_setting('assistant.tenant',true)::uuid AND customer_id=current_setting('assistant.customer',true)::uuid);
CREATE POLICY turns_owner ON assistant.turns USING(tenant_id=current_setting('assistant.tenant',true)::uuid AND customer_id=current_setting('assistant.customer',true)::uuid);
CREATE POLICY metrics_tenant ON assistant.metrics USING(tenant_id=current_setting('assistant.tenant',true)::uuid);
CREATE POLICY documents_tenant ON assistant.documents USING(tenant_id=current_setting('assistant.tenant',true)::uuid);
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA assistant TO ai_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA assistant TO ai_runtime;
ALTER ROLE ai_runtime SET statement_timeout='1500ms';
ALTER ROLE ai_runtime SET idle_in_transaction_session_timeout='5s';
ALTER ROLE ai_runtime CONNECTION LIMIT 8;
-- Narrow maintenance capability: runtime can purge expired rows only in its configured tenant.
CREATE FUNCTION assistant.purge_expired(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF target IS DISTINCT FROM current_setting('assistant.tenant',true)::uuid THEN
   RAISE EXCEPTION 'Tenant context required';
 END IF;
 DELETE FROM assistant.conversations WHERE tenant_id=target AND created_at<now()-interval '30 days';
 DELETE FROM assistant.metrics WHERE tenant_id=target AND created_at<now()-interval '90 days';
END; $$;
REVOKE ALL ON FUNCTION assistant.purge_expired(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assistant.purge_expired(uuid) TO ai_runtime;
