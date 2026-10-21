BEGIN;
-- Operator-only upload area. No staging row is visible to a runtime release.
CREATE TABLE knowledge.bulk_imports (
 id text PRIMARY KEY CHECK(id ~ '^[a-f0-9]{64}$'),
 manifest jsonb NOT NULL CHECK(jsonb_typeof(manifest)='object'),
 expected_fingerprint text NOT NULL CHECK(expected_fingerprint ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','imported','cancelled')),
 release_id uuid REFERENCES release.dictionaries(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status='imported')=(release_id IS NOT NULL))
);
CREATE TABLE knowledge.bulk_chunks (
 import_id text NOT NULL REFERENCES knowledge.bulk_imports(id),
 ordinal integer NOT NULL CHECK(ordinal>=0),
 sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 record_count integer NOT NULL CHECK(record_count BETWEEN 1 AND 500),
 byte_count integer NOT NULL CHECK(byte_count BETWEEN 1 AND 1048576),
 completed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(import_id,ordinal)
);
CREATE TABLE knowledge.bulk_concepts (
 import_id text NOT NULL,
 chunk_ordinal integer NOT NULL,
 position integer NOT NULL CHECK(position BETWEEN 0 AND 499),
 code text NOT NULL,
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND record->>'id'=code),
 PRIMARY KEY(import_id,code),
 UNIQUE(import_id,chunk_ordinal,position),
 FOREIGN KEY(import_id,chunk_ordinal) REFERENCES knowledge.bulk_chunks(import_id,ordinal)
);
CREATE TRIGGER bulk_chunk_immutable BEFORE UPDATE OR DELETE ON knowledge.bulk_chunks
 FOR EACH ROW EXECUTE FUNCTION knowledge.reject_pack_mutation();
CREATE TRIGGER bulk_concept_immutable BEFORE UPDATE OR DELETE ON knowledge.bulk_concepts
 FOR EACH ROW EXECUTE FUNCTION knowledge.reject_pack_mutation();
CREATE FUNCTION knowledge.protect_bulk_import() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Bulk import audit records are immutable'; END IF;
 IF NEW.id<>OLD.id OR NEW.manifest<>OLD.manifest OR NEW.expected_fingerprint<>OLD.expected_fingerprint
    OR NEW.created_at<>OLD.created_at OR OLD.status<>'uploading' THEN
  RAISE EXCEPTION 'Bulk import identity and terminal state are immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER bulk_import_identity BEFORE UPDATE OR DELETE ON knowledge.bulk_imports
 FOR EACH ROW EXECUTE FUNCTION knowledge.protect_bulk_import();
REVOKE ALL ON knowledge.bulk_imports,knowledge.bulk_chunks,knowledge.bulk_concepts FROM PUBLIC;
COMMIT;
