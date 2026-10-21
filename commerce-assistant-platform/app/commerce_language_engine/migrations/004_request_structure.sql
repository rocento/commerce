BEGIN;
CREATE TABLE IF NOT EXISTS request_prefixes (
 id bigserial PRIMARY KEY,
 phrase text NOT NULL UNIQUE,
 active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS action_frames (
 id bigserial PRIMARY KEY,
 code text NOT NULL UNIQUE,
 intent_id bigint NOT NULL REFERENCES commerce_intents(id),
 actions jsonb NOT NULL CHECK(jsonb_array_length(actions)>0),
 targets jsonb NOT NULL CHECK(jsonb_array_length(targets)>0),
 prepositions jsonb NOT NULL CHECK(jsonb_array_length(prepositions)>0),
 excluded_objects jsonb NOT NULL DEFAULT '[]',
 selection_required boolean NOT NULL DEFAULT true,
 active boolean NOT NULL DEFAULT true
);
CREATE INDEX IF NOT EXISTS action_frames_intent_idx ON action_frames(intent_id);
COMMIT;
