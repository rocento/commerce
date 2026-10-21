BEGIN;
ALTER TABLE intent_rules ADD COLUMN IF NOT EXISTS code text NOT NULL DEFAULT 'primary';
ALTER TABLE intent_rules ADD COLUMN IF NOT EXISTS required_states jsonb NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX IF NOT EXISTS intent_rule_code_idx ON intent_rules(intent_id,code);
ALTER TABLE intent_rule_conditions ADD COLUMN IF NOT EXISTS near_group_id bigint REFERENCES semantic_groups(id);
COMMIT;
