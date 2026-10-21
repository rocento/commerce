CREATE SCHEMA IF NOT EXISTS merchant_ai;
CREATE TABLE merchant_ai.messages (
 admin_id uuid NOT NULL REFERENCES admin_iam.admin_users(id) ON DELETE CASCADE,
 conversation_id uuid NOT NULL, request_id uuid NOT NULL,
 question text NOT NULL, request jsonb NOT NULL, response jsonb NOT NULL,
 latency_ms integer NOT NULL CHECK(latency_ms BETWEEN 0 AND 60000), helpful boolean,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(admin_id,request_id), CHECK(octet_length(response::text)<=65536)
);
CREATE INDEX merchant_ai_owner_history ON merchant_ai.messages(admin_id,created_at DESC);
