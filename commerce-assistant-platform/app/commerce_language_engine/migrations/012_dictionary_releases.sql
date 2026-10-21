BEGIN;
CREATE SCHEMA IF NOT EXISTS release;

CREATE TABLE release.dictionaries (
 id uuid PRIMARY KEY,
 dictionary_version integer NOT NULL CHECK(dictionary_version>0),
 fingerprint text NOT NULL CHECK(length(fingerprint)>0),
 schema_version integer NOT NULL CHECK(schema_version>0),
 artifact jsonb NOT NULL CHECK(jsonb_typeof(artifact)='object'),
 manifest jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(manifest)='object'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX release_dictionaries_fingerprint_idx ON release.dictionaries(fingerprint,created_at DESC);

CREATE TABLE release.channels (
 channel text PRIMARY KEY CHECK(length(channel)>0),
 release_id uuid NOT NULL REFERENCES release.dictionaries(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE release.activations (
 id bigserial PRIMARY KEY,
 channel text NOT NULL,
 release_id uuid NOT NULL REFERENCES release.dictionaries(id),
 activated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX release_activations_channel_idx ON release.activations(channel,activated_at DESC);

CREATE FUNCTION release.reject_dictionary_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'published dictionary releases are immutable'; END $$;
CREATE TRIGGER dictionary_release_immutable
 BEFORE UPDATE OR DELETE ON release.dictionaries
 FOR EACH ROW EXECUTE FUNCTION release.reject_dictionary_mutation();

ALTER TABLE utterance.generation_runs ADD COLUMN release_id uuid REFERENCES release.dictionaries(id);
ALTER TABLE evaluation.results ADD COLUMN release_id uuid REFERENCES release.dictionaries(id);
ALTER TABLE resolution.feedback ADD COLUMN release_id uuid REFERENCES release.dictionaries(id);
ALTER TABLE scoring.confidence_calibrations ADD COLUMN release_id uuid REFERENCES release.dictionaries(id);

COMMIT;
