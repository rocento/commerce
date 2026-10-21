BEGIN;
-- Preserve historical reports without manufacturing exact-runtime evidence.
ALTER TABLE evaluation.results RENAME TO legacy_results;
CREATE TRIGGER legacy_evaluation_immutable BEFORE INSERT OR UPDATE OR DELETE ON evaluation.legacy_results
 FOR EACH ROW EXECUTE FUNCTION release.reject_dictionary_mutation();
CREATE VIEW evaluation.results AS
 SELECT 'legacy:'||id::text AS id,created_at,dictionary_version,metrics,release_id
 FROM evaluation.legacy_results
 UNION ALL
 SELECT 'release:'||e.id::text,e.created_at,d.dictionary_version,
 e.report||jsonb_build_object('releaseEvidenceId',e.id,'runtimeSha256',e.runtime_sha256,
 'rubricVersion',e.rubric_version,'passed',e.passed),e.release_id
 FROM release.evaluations e JOIN release.dictionaries d ON d.id=e.release_id
 WHERE NOT EXISTS(SELECT 1 FROM evaluation.legacy_results l WHERE l.metrics->>'releaseEvidenceId'=e.id::text);
-- Compatibility with older operator images during a rolling upgrade. Their
-- duplicate write is acknowledged, but only exact existing evidence qualifies.
CREATE FUNCTION evaluation.accept_existing_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM release.evaluations e JOIN release.dictionaries d ON d.id=e.release_id
  WHERE e.id::text=NEW.metrics->>'releaseEvidenceId' AND e.release_id=NEW.release_id
  AND d.dictionary_version=NEW.dictionary_version
  AND NEW.metrics=e.report||jsonb_build_object('releaseEvidenceId',e.id,'runtimeSha256',e.runtime_sha256,
    'rubricVersion',e.rubric_version,'passed',e.passed)) THEN
  RAISE EXCEPTION 'Write authoritative evaluation evidence through the release workflow';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER evaluation_compatibility_insert INSTEAD OF INSERT ON evaluation.results
 FOR EACH ROW EXECUTE FUNCTION evaluation.accept_existing_evidence();
CREATE VIEW release.production_status AS
 SELECT c.release_id,d.dictionary_version,d.fingerprint,c.updated_at,
 EXISTS(SELECT 1 FROM release.candidates k WHERE k.release_id=d.id) AS has_candidate_provenance,
 a.evaluation_id,a.actor,a.reason,a.operation
 FROM release.channels c JOIN release.dictionaries d ON d.id=c.release_id
 LEFT JOIN LATERAL(SELECT * FROM release.activations WHERE channel=c.channel ORDER BY id DESC LIMIT 1) a ON true
 WHERE c.channel='production';
COMMENT ON VIEW release.production_status IS 'Published artifact identity; normalized authoring tables are not guaranteed to represent this release.';
COMMIT;
