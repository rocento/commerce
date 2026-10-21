BEGIN;
-- Snapshot the actual immutable active release. Never infer a baseline from mutable authoring tables.
CREATE TABLE release.baselines (
 release_id uuid PRIMARY KEY REFERENCES release.dictionaries(id),
 origin text NOT NULL CHECK(origin IN ('existing-active','explicit-bootstrap')),
 recorded_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO release.baselines(release_id,origin)
 SELECT release_id,'existing-active' FROM release.channels WHERE channel='production';
CREATE TABLE release.drafts (
 id uuid PRIMARY KEY,
 base_release_id uuid REFERENCES release.dictionaries(id),
 source text NOT NULL CHECK(length(source)>0),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE release.draft_revisions (
 draft_id uuid NOT NULL REFERENCES release.drafts(id),
 revision integer NOT NULL CHECK(revision>0),
 artifact jsonb NOT NULL CHECK(jsonb_typeof(artifact)='object'),
 corpus_gzip bytea NOT NULL,
 manifest jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(manifest)='object'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(draft_id,revision)
);
CREATE TABLE release.draft_changes (
 draft_id uuid NOT NULL,
 revision integer NOT NULL,
 change_key text NOT NULL CHECK(length(change_key)>0),
 kind text NOT NULL CHECK(length(kind)>0),
 payload jsonb NOT NULL,
 PRIMARY KEY(draft_id,revision,change_key),
 FOREIGN KEY(draft_id,revision) REFERENCES release.draft_revisions(draft_id,revision)
);
CREATE TABLE release.candidates (
 release_id uuid PRIMARY KEY REFERENCES release.dictionaries(id),
 draft_id uuid NOT NULL,
 draft_revision integer NOT NULL,
 base_release_id uuid REFERENCES release.dictionaries(id),
 artifact_sha256 text NOT NULL CHECK(artifact_sha256 ~ '^[a-f0-9]{64}$'),
 corpus_sha256 text NOT NULL CHECK(corpus_sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(draft_id,draft_revision),
 FOREIGN KEY(draft_id,draft_revision) REFERENCES release.draft_revisions(draft_id,revision)
);
CREATE TABLE release.evaluations (
 id uuid PRIMARY KEY,
 release_id uuid NOT NULL REFERENCES release.candidates(release_id),
 artifact_sha256 text NOT NULL CHECK(artifact_sha256 ~ '^[a-f0-9]{64}$'),
 corpus_sha256 text NOT NULL CHECK(corpus_sha256 ~ '^[a-f0-9]{64}$'),
 runtime_sha256 text NOT NULL CHECK(runtime_sha256 ~ '^[a-f0-9]{64}$'),
 rubric_version text NOT NULL CHECK(length(rubric_version)>0),
 contract_version text NOT NULL CHECK(length(contract_version)>0),
 passed boolean NOT NULL,
 report jsonb NOT NULL CHECK(jsonb_typeof(report)='object'),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX release_evaluations_candidate_idx ON release.evaluations(release_id,created_at DESC);
ALTER TABLE release.activations ADD COLUMN previous_release_id uuid REFERENCES release.dictionaries(id);
ALTER TABLE release.activations ADD COLUMN evaluation_id uuid REFERENCES release.evaluations(id);
ALTER TABLE release.activations ADD COLUMN actor text;
ALTER TABLE release.activations ADD COLUMN reason text;
ALTER TABLE release.activations ADD COLUMN operation text CHECK(operation IN ('promotion','bootstrap','rollback'));
-- Historical activations deliberately retain NULL provenance.
CREATE TRIGGER release_draft_immutable BEFORE UPDATE OR DELETE ON release.drafts FOR EACH ROW EXECUTE FUNCTION release.reject_dictionary_mutation();
CREATE TRIGGER release_draft_revision_immutable BEFORE UPDATE OR DELETE ON release.draft_revisions FOR EACH ROW EXECUTE FUNCTION release.reject_dictionary_mutation();
CREATE TRIGGER release_draft_changes_immutable BEFORE UPDATE OR DELETE ON release.draft_changes FOR EACH ROW EXECUTE FUNCTION release.reject_dictionary_mutation();
CREATE TRIGGER release_candidate_immutable BEFORE UPDATE OR DELETE ON release.candidates FOR EACH ROW EXECUTE FUNCTION release.reject_dictionary_mutation();
CREATE TRIGGER release_evaluation_immutable BEFORE UPDATE OR DELETE ON release.evaluations FOR EACH ROW EXECUTE FUNCTION release.reject_dictionary_mutation();
ALTER TABLE release.activations ADD COLUMN transaction_id bigint;
ALTER TABLE release.activations ALTER COLUMN transaction_id SET DEFAULT txid_current();
CREATE FUNCTION release.validate_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_id uuid; approved boolean;
BEGIN
 IF NEW.operation IS NULL OR coalesce(length(NEW.actor),0)=0 OR coalesce(length(NEW.reason),0)=0 THEN
  RAISE EXCEPTION 'activation requires explicit lifecycle operation, actor and reason';
 END IF;
 PERFORM pg_advisory_xact_lock(57439);
 SELECT release_id INTO current_id FROM release.channels WHERE channel=NEW.channel;
 IF current_id IS DISTINCT FROM NEW.previous_release_id THEN RAISE EXCEPTION 'active release changed'; END IF;
 IF NEW.operation='promotion' THEN
  SELECT e.passed AND e.release_id=NEW.release_id AND c.base_release_id IS NOT DISTINCT FROM current_id
   AND e.artifact_sha256=c.artifact_sha256 AND e.corpus_sha256=c.corpus_sha256
  INTO approved FROM release.evaluations e JOIN release.candidates c ON c.release_id=e.release_id WHERE e.id=NEW.evaluation_id;
  IF approved IS DISTINCT FROM true THEN RAISE EXCEPTION 'promotion requires exact passing candidate evidence and current base'; END IF;
 ELSIF NEW.operation='bootstrap' THEN
  IF current_id IS NOT NULL OR EXISTS(SELECT 1 FROM release.activations) THEN RAISE EXCEPTION 'bootstrap requires a never-activated database'; END IF;
 ELSIF NEW.operation='rollback' THEN
  IF NOT EXISTS(SELECT 1 FROM release.baselines WHERE release_id=NEW.release_id) AND NOT EXISTS(SELECT 1 FROM release.activations WHERE release_id=NEW.release_id AND operation IN ('promotion','bootstrap')) THEN RAISE EXCEPTION 'rollback target has no baseline or approved activation'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER release_activation_gate BEFORE INSERT ON release.activations FOR EACH ROW EXECUTE FUNCTION release.validate_activation();
CREATE TRIGGER release_activation_immutable BEFORE UPDATE OR DELETE ON release.activations FOR EACH ROW EXECUTE FUNCTION release.reject_dictionary_mutation();
CREATE FUNCTION release.validate_channel_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'release channels cannot be deleted'; END IF;
 IF NOT EXISTS(SELECT 1 FROM release.activations WHERE channel=NEW.channel AND release_id=NEW.release_id AND transaction_id=txid_current()) THEN
  RAISE EXCEPTION 'channel changes require a gated activation in the same transaction';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER release_channel_gate BEFORE INSERT OR UPDATE OR DELETE ON release.channels FOR EACH ROW EXECUTE FUNCTION release.validate_channel_change();
CREATE FUNCTION release.guard_frozen_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM release.candidates WHERE draft_id=NEW.draft_id AND draft_revision=NEW.revision) THEN RAISE EXCEPTION 'frozen draft membership is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER release_frozen_draft_gate BEFORE INSERT ON release.draft_changes FOR EACH ROW EXECUTE FUNCTION release.guard_frozen_draft();
CREATE TRIGGER release_baseline_immutable BEFORE UPDATE OR DELETE ON release.baselines FOR EACH ROW EXECUTE FUNCTION release.reject_dictionary_mutation();
COMMIT;
