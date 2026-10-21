-- Add conversation ownership without rewriting the previously applied messages migration.
CREATE TABLE merchant_ai.conversations (
 admin_id uuid NOT NULL REFERENCES admin_iam.admin_users(id) ON DELETE CASCADE,
 id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(admin_id,id)
);
INSERT INTO merchant_ai.conversations(admin_id,id,created_at)
SELECT admin_id,conversation_id,min(created_at) FROM merchant_ai.messages GROUP BY admin_id,conversation_id;
ALTER TABLE merchant_ai.messages ADD CONSTRAINT messages_conversation_owner_fkey
 FOREIGN KEY(admin_id,conversation_id) REFERENCES merchant_ai.conversations(admin_id,id) ON DELETE CASCADE;
