BEGIN;
ALTER TABLE generated_utterances ADD COLUMN IF NOT EXISTS split text NOT NULL DEFAULT 'train' CHECK (split IN ('train','development','test'));
ALTER TABLE generated_utterances ADD COLUMN IF NOT EXISTS template_family text NOT NULL DEFAULT 'legacy';
ALTER TABLE generated_utterances ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'legacy';
ALTER TABLE generated_utterances ADD COLUMN IF NOT EXISTS content_hash text;
CREATE UNIQUE INDEX IF NOT EXISTS utterances_hash_idx ON generated_utterances(content_hash);
CREATE INDEX IF NOT EXISTS utterances_split_difficulty_idx ON generated_utterances(split,difficulty);
ALTER TABLE phrase_patterns ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'curated';
CREATE TABLE IF NOT EXISTS generation_runs (
 id bigserial PRIMARY KEY,
 created_at timestamptz NOT NULL DEFAULT now(),
 dictionary_version integer NOT NULL,
 fingerprint text NOT NULL,
 manifest jsonb NOT NULL,
 active boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX IF NOT EXISTS generation_active_idx ON generation_runs(active) WHERE active;
COMMIT;
