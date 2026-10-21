BEGIN;
-- Preserve the legacy table for existing inspectors and migration reruns.
-- Runtime generation and loading now use entity_terms exclusively.
CREATE TABLE IF NOT EXISTS entity_terms (
 id bigserial PRIMARY KEY,
 entity_type_id bigint NOT NULL REFERENCES entity_types(id),
 alias text NOT NULL,
 normalized_alias text NOT NULL,
 canonical_value text NOT NULL,
 industry_id bigint REFERENCES industry_packs(id),
 active boolean NOT NULL DEFAULT true,
 UNIQUE(entity_type_id,normalized_alias)
);
INSERT INTO entity_terms(entity_type_id,alias,normalized_alias,canonical_value,industry_id,active)
 SELECT entity_type_id,alias,normalized_alias,canonical_value,industry_id,active FROM entity_aliases
 ON CONFLICT DO NOTHING;
CREATE INDEX IF NOT EXISTS entity_terms_normalized_idx ON entity_terms(normalized_alias);
COMMIT;
