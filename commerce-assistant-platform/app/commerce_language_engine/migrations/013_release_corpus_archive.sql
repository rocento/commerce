BEGIN;
ALTER TABLE release.dictionaries ADD COLUMN corpus_gzip bytea;
COMMIT;
