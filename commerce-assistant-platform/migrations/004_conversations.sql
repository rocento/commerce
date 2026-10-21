-- Additive provider-neutral messages; existing conversations/turns and forced RLS remain authoritative.
CREATE TABLE IF NOT EXISTS assistant.messages (
 tenant_id uuid NOT NULL, customer_id uuid NOT NULL, request_id uuid NOT NULL,
 role text NOT NULL CHECK(role IN ('user','assistant')), text text NOT NULL CHECK(length(text)<=8000),
 blocks jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(blocks)='array' AND octet_length(blocks::text)<=32768),
 metadata jsonb NOT NULL DEFAULT '{}' CHECK(octet_length(metadata::text)<=2048),
 helpful boolean, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,customer_id,request_id,role),
 FOREIGN KEY(tenant_id,customer_id,request_id) REFERENCES assistant.turns(tenant_id,customer_id,request_id) ON DELETE CASCADE
);
ALTER TABLE assistant.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messages_owner ON assistant.messages;
CREATE POLICY messages_owner ON assistant.messages USING(tenant_id=(SELECT tenant_id FROM assistant.deployment WHERE singleton) AND tenant_id=current_setting('assistant.tenant',true)::uuid AND customer_id=current_setting('assistant.customer',true)::uuid);
GRANT SELECT,INSERT,UPDATE,DELETE ON assistant.messages TO ai_runtime;
ALTER TABLE assistant.metrics ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE assistant.metrics ADD COLUMN IF NOT EXISTS conversation_id uuid;
ALTER TABLE assistant.metrics ADD COLUMN IF NOT EXISTS helpful boolean;
-- Preserve legacy text messages while adding the new typed domain projection.
INSERT INTO assistant.messages(tenant_id,customer_id,request_id,role,text,created_at)
SELECT t.tenant_id,t.customer_id,t.request_id,m.role,m.text,t.created_at
FROM assistant.turns t CROSS JOIN LATERAL (VALUES ('user',t.question),('assistant',t.answer)) AS m(role,text)
ON CONFLICT DO NOTHING;
