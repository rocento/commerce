BEGIN;
ALTER TABLE clarification_policies ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMIT;
