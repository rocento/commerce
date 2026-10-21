BEGIN;
ALTER TABLE action.frames ADD COLUMN sources jsonb NOT NULL DEFAULT '[]'::jsonb
 CHECK (jsonb_typeof(sources) = 'array');
COMMIT;
