BEGIN;
-- External origin is provenance, not a claim that an ancestor exists in this database.
CREATE TABLE release.imported_baselines (
 release_id uuid PRIMARY KEY REFERENCES release.dictionaries(id),
 origin_parent_release_id uuid,
 artifact_sha256 text NOT NULL CHECK(artifact_sha256 ~ '^[a-f0-9]{64}$'),
 corpus_sha256 text NOT NULL CHECK(corpus_sha256 ~ '^[a-f0-9]{64}$'),
 runtime_sha256 text NOT NULL CHECK(runtime_sha256 ~ '^[a-f0-9]{64}$'),
 imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER release_imported_baseline_immutable BEFORE UPDATE OR DELETE ON release.imported_baselines FOR EACH ROW EXECUTE FUNCTION release.reject_dictionary_mutation();
COMMIT;
