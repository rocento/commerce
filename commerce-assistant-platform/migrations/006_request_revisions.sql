-- One active clarification revision per scoped conversation. No commerce state.
CREATE TABLE IF NOT EXISTS assistant.request_revisions (
 tenant_id uuid NOT NULL, customer_id uuid NOT NULL, conversation_id uuid NOT NULL,
 revision uuid NOT NULL, pending boolean NOT NULL DEFAULT false,
 original_hash text, question_hash text, expires_at timestamptz,
 PRIMARY KEY(tenant_id,customer_id,conversation_id),
 FOREIGN KEY(tenant_id,customer_id,conversation_id)
 REFERENCES assistant.conversations(tenant_id,customer_id,id) ON DELETE CASCADE,
 CHECK(NOT pending OR (original_hash IS NOT NULL AND question_hash IS NOT NULL
 AND length(original_hash)=64 AND length(question_hash)=64 AND expires_at IS NOT NULL))
);
ALTER TABLE assistant.request_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE assistant.request_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS request_revisions_owner ON assistant.request_revisions;
CREATE POLICY request_revisions_owner ON assistant.request_revisions USING(
 tenant_id=(SELECT tenant_id FROM assistant.deployment WHERE singleton)
 AND tenant_id=current_setting('assistant.tenant',true)::uuid
 AND customer_id=current_setting('assistant.customer',true)::uuid
);
GRANT SELECT,INSERT,UPDATE,DELETE ON assistant.request_revisions TO ai_runtime;
