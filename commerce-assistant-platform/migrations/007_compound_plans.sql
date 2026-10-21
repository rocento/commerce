-- Non-executing compound plans and correlated action outcomes.
CREATE TABLE IF NOT EXISTS assistant.compound_plans (
 tenant_id uuid NOT NULL, customer_id uuid NOT NULL, conversation_id uuid NOT NULL,
 request_id uuid NOT NULL, plan_id uuid NOT NULL, revision uuid NOT NULL,
 input_hash text NOT NULL CHECK(length(input_hash)=64),
 payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object' AND octet_length(payload::text)<=32768),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(tenant_id,customer_id,request_id),
 UNIQUE(tenant_id,customer_id,plan_id),
 FOREIGN KEY(tenant_id,customer_id,conversation_id)
 REFERENCES assistant.conversations(tenant_id,customer_id,id) ON DELETE CASCADE
);
ALTER TABLE assistant.compound_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.compound_plans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS compound_plans_owner ON assistant.compound_plans;
CREATE POLICY compound_plans_owner ON assistant.compound_plans USING(
 tenant_id=(SELECT tenant_id FROM assistant.deployment WHERE singleton)
 AND tenant_id=current_setting('assistant.tenant',true)::uuid
 AND customer_id=current_setting('assistant.customer',true)::uuid
);
GRANT SELECT,INSERT,UPDATE,DELETE ON assistant.compound_plans TO ai_runtime;
