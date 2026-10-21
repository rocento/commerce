BEGIN;
-- These associations are intentionally separate from unscoped entity.aliases.
CREATE SCHEMA IF NOT EXISTS knowledge;
CREATE TABLE knowledge.packs (
 sha256 text PRIMARY KEY CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 code text NOT NULL,
 revision integer NOT NULL CHECK(revision>0),
 schema_version integer NOT NULL CHECK(schema_version=1),
 language_code text NOT NULL CHECK(language_code='en'),
 source text NOT NULL CHECK(length(source)>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(code,revision)
);
CREATE TABLE knowledge.concepts (
 pack_sha256 text NOT NULL REFERENCES knowledge.packs(sha256),
 code text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('color','country','person','activity','occasion')),
 canonical text NOT NULL CHECK(length(canonical)>0),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(metadata)='object'),
 PRIMARY KEY(pack_sha256,code)
);
CREATE TABLE knowledge.aliases (
 pack_sha256 text NOT NULL,
 concept_code text NOT NULL,
 lexicon_term_id bigint NOT NULL REFERENCES lexicon.terms(id),
 surface text NOT NULL CHECK(length(surface)>0),
 is_canonical boolean NOT NULL DEFAULT false,
 PRIMARY KEY(pack_sha256,concept_code,lexicon_term_id),
 FOREIGN KEY(pack_sha256,concept_code) REFERENCES knowledge.concepts(pack_sha256,code)
);
CREATE INDEX knowledge_aliases_lexical_idx ON knowledge.aliases(lexicon_term_id,pack_sha256);
CREATE INDEX knowledge_concepts_kind_idx ON knowledge.concepts(pack_sha256,kind);
CREATE TABLE knowledge.rules (
 pack_sha256 text NOT NULL REFERENCES knowledge.packs(sha256),
 code text NOT NULL,
 marker text NOT NULL CHECK(length(marker)>0),
 target_kind text NOT NULL CHECK(target_kind IN ('color','country','person','activity','occasion')),
 relation text NOT NULL CHECK(relation IN ('intended_use','recipient','audience','occasion','color','origin_country','destination_country','market_country')),
 scope text NOT NULL CHECK(scope IN ('product','delivery')),
 priority integer NOT NULL CHECK(priority>=0 AND priority<=10000),
 target_metadata jsonb CHECK(target_metadata IS NULL OR jsonb_typeof(target_metadata)='object'),
 PRIMARY KEY(pack_sha256,code)
);
CREATE FUNCTION knowledge.reject_pack_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'language knowledge revisions are immutable; import a new revision'; END $$;
CREATE TRIGGER knowledge_pack_immutable BEFORE UPDATE OR DELETE ON knowledge.packs FOR EACH ROW EXECUTE FUNCTION knowledge.reject_pack_mutation();
CREATE TRIGGER knowledge_concept_immutable BEFORE UPDATE OR DELETE ON knowledge.concepts FOR EACH ROW EXECUTE FUNCTION knowledge.reject_pack_mutation();
CREATE TRIGGER knowledge_alias_immutable BEFORE UPDATE OR DELETE ON knowledge.aliases FOR EACH ROW EXECUTE FUNCTION knowledge.reject_pack_mutation();
CREATE TRIGGER knowledge_rule_immutable BEFORE UPDATE OR DELETE ON knowledge.rules FOR EACH ROW EXECUTE FUNCTION knowledge.reject_pack_mutation();
COMMIT;
