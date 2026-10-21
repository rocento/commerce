-- Operator-applied additive indexes; existing records and RLS policies are unchanged.
CREATE INDEX IF NOT EXISTS assistant_turns_conversation_time
 ON assistant.turns(tenant_id,customer_id,conversation_id,created_at DESC,request_id DESC);
CREATE INDEX IF NOT EXISTS assistant_conversations_retention
 ON assistant.conversations(tenant_id,created_at);
CREATE INDEX IF NOT EXISTS assistant_metrics_window
 ON assistant.metrics(tenant_id,created_at DESC);
CREATE INDEX IF NOT EXISTS assistant_metrics_export_pending
 ON assistant.metrics(tenant_id,created_at) WHERE exported_at IS NULL;
