BEGIN;

CREATE TABLE lexicon.terms (
 id bigserial PRIMARY KEY,
 term text NOT NULL,
 normalized_term text NOT NULL UNIQUE CHECK(length(normalized_term)>0),
 language_code text NOT NULL DEFAULT 'en',
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now()
);

WITH source_terms AS (
 SELECT term,normalized_term FROM semantic.terms
 UNION ALL
 SELECT alias,normalized_alias FROM entity.terms
 UNION ALL
 SELECT alias,normalized_alias FROM entity.aliases
), chosen AS (
 SELECT DISTINCT ON (normalized_term) term,normalized_term
 FROM source_terms WHERE length(normalized_term)>0
 ORDER BY normalized_term,term
)
INSERT INTO lexicon.terms(term,normalized_term) SELECT term,normalized_term FROM chosen;

ALTER TABLE semantic.terms ADD COLUMN lexicon_term_id bigint REFERENCES lexicon.terms(id);
UPDATE semantic.terms s SET lexicon_term_id=l.id FROM lexicon.terms l WHERE l.normalized_term=s.normalized_term;
ALTER TABLE semantic.terms ALTER COLUMN lexicon_term_id SET NOT NULL;
ALTER TABLE semantic.terms DROP CONSTRAINT semantic_terms_semantic_group_id_normalized_term_key;
ALTER TABLE semantic.terms DROP COLUMN term;
ALTER TABLE semantic.terms DROP COLUMN normalized_term;
ALTER TABLE semantic.terms ALTER COLUMN lexicon_term_id SET NOT NULL;
ALTER TABLE semantic.terms ADD CONSTRAINT semantic_terms_group_lexicon_key UNIQUE(semantic_group_id,lexicon_term_id);
CREATE INDEX semantic_terms_lexicon_idx ON semantic.terms(lexicon_term_id);

CREATE SCHEMA entity_legacy;
ALTER TABLE entity.terms SET SCHEMA entity_legacy;
ALTER TABLE entity.aliases SET SCHEMA entity_legacy;

CREATE TABLE entity.terms (
 id bigserial PRIMARY KEY,
 entity_type_id bigint NOT NULL REFERENCES entity.types(id),
 canonical_value text NOT NULL,
 industry_id bigint REFERENCES industry.packs(id),
 active boolean NOT NULL DEFAULT true,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 UNIQUE NULLS NOT DISTINCT(entity_type_id,canonical_value,industry_id)
);
CREATE INDEX entity_terms_type_idx ON entity.terms(entity_type_id);

CREATE TABLE entity.aliases (
 id bigserial PRIMARY KEY,
 lexicon_term_id bigint NOT NULL REFERENCES lexicon.terms(id),
 entity_value_id bigint NOT NULL REFERENCES entity.terms(id) ON DELETE CASCADE,
 industry_id bigint REFERENCES industry.packs(id),
 active boolean NOT NULL DEFAULT true,
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 UNIQUE NULLS NOT DISTINCT(lexicon_term_id,entity_value_id,industry_id)
);
CREATE INDEX entity_aliases_term_idx ON entity.aliases(lexicon_term_id) WHERE active;
CREATE INDEX entity_aliases_value_idx ON entity.aliases(entity_value_id) WHERE active;

WITH source_values AS (
 SELECT entity_type_id,canonical_value,industry_id,active FROM entity_legacy.terms
 UNION ALL
 SELECT entity_type_id,canonical_value,industry_id,active FROM entity_legacy.aliases
)
INSERT INTO entity.terms(entity_type_id,canonical_value,industry_id,active)
SELECT entity_type_id,canonical_value,industry_id,bool_or(active)
FROM source_values GROUP BY entity_type_id,canonical_value,industry_id
ON CONFLICT(entity_type_id,canonical_value,industry_id) DO UPDATE SET active=entity.terms.active OR EXCLUDED.active;

WITH source_aliases AS (
 SELECT entity_type_id,alias,normalized_alias,canonical_value,industry_id,active FROM entity_legacy.terms
 UNION ALL
 SELECT entity_type_id,alias,normalized_alias,canonical_value,industry_id,active FROM entity_legacy.aliases
)
INSERT INTO entity.aliases(lexicon_term_id,entity_value_id,industry_id,active)
SELECT l.id,v.id,s.industry_id,bool_or(s.active)
FROM source_aliases s
JOIN lexicon.terms l ON l.normalized_term=s.normalized_alias
JOIN entity.terms v ON v.entity_type_id=s.entity_type_id AND v.canonical_value=s.canonical_value AND v.industry_id IS NOT DISTINCT FROM s.industry_id
GROUP BY l.id,v.id,s.industry_id
ON CONFLICT(lexicon_term_id,entity_value_id,industry_id) DO UPDATE SET active=entity.aliases.active OR EXCLUDED.active;

COMMIT;
