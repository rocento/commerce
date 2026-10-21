BEGIN;
ALTER TABLE semantic_composition_rules ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
COMMIT;
