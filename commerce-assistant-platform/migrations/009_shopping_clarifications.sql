-- Typed discovery continuations are server-owned and bound to the trusted session.
-- The existing forced tenant/customer RLS and conversation CAS remain in effect.
ALTER TABLE assistant.request_revisions ADD COLUMN IF NOT EXISTS shopping_state jsonb;
ALTER TABLE assistant.request_revisions ADD COLUMN IF NOT EXISTS shopping_store_id uuid;
ALTER TABLE assistant.request_revisions ADD COLUMN IF NOT EXISTS shopping_session_id uuid;
ALTER TABLE assistant.request_revisions ADD COLUMN IF NOT EXISTS shopping_active_state jsonb;
ALTER TABLE assistant.request_revisions ADD COLUMN IF NOT EXISTS shopping_active_store_id uuid;
ALTER TABLE assistant.request_revisions ADD COLUMN IF NOT EXISTS shopping_active_session_id uuid;
ALTER TABLE assistant.request_revisions ADD COLUMN IF NOT EXISTS shopping_active_expires_at timestamptz;
ALTER TABLE assistant.request_revisions DROP CONSTRAINT IF EXISTS shopping_state_bounded;
ALTER TABLE assistant.request_revisions ADD CONSTRAINT shopping_state_bounded CHECK (
 shopping_state IS NULL OR (
  pending AND shopping_store_id IS NOT NULL AND shopping_session_id IS NOT NULL
  AND jsonb_typeof(shopping_state)='object'
  AND octet_length(shopping_state::text)<=32768
 )
);
ALTER TABLE assistant.request_revisions DROP CONSTRAINT IF EXISTS shopping_active_bounded;
ALTER TABLE assistant.request_revisions ADD CONSTRAINT shopping_active_bounded CHECK (
 shopping_active_state IS NULL OR (
  NOT pending AND shopping_active_store_id IS NOT NULL AND shopping_active_session_id IS NOT NULL
  AND shopping_active_expires_at IS NOT NULL AND jsonb_typeof(shopping_active_state)='object'
  AND octet_length(shopping_active_state::text)<=32768
 )
);
