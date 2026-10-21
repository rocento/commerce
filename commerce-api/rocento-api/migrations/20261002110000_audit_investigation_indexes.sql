-- Exact investigation filters followed by stable chronological keyset pagination.
CREATE INDEX IF NOT EXISTS audit_actor_created_id ON admin_iam.audit_log(actor_id, created_at, id);
CREATE INDEX IF NOT EXISTS audit_entity_created_id ON admin_iam.audit_log(entity_id, created_at, id);
CREATE INDEX IF NOT EXISTS audit_action_created_id ON admin_iam.audit_log(action, created_at, id);
