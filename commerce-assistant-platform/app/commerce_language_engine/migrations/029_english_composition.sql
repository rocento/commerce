BEGIN;
ALTER TABLE knowledge.concepts DROP CONSTRAINT concepts_kind_check;
ALTER TABLE knowledge.concepts ADD CONSTRAINT concepts_kind_check CHECK(kind IN ('color','country','person','activity','occasion','device','material','product','unit','dimension'));
ALTER TABLE knowledge.rules DROP CONSTRAINT rules_target_kind_check;
ALTER TABLE knowledge.rules ADD CONSTRAINT rules_target_kind_check CHECK(target_kind IN ('color','country','person','activity','occasion','device','material'));
ALTER TABLE knowledge.rules DROP CONSTRAINT rules_relation_check;
ALTER TABLE knowledge.rules ADD CONSTRAINT rules_relation_check CHECK(relation IN ('intended_use','recipient','audience','occasion','color','origin_country','destination_country','market_country','compatibility_target','material'));
ALTER TABLE knowledge.rules ADD COLUMN negated boolean NOT NULL DEFAULT false;
ALTER TABLE knowledge.rules ADD COLUMN requires_clarification boolean NOT NULL DEFAULT false;
ALTER TABLE knowledge.rules ADD CONSTRAINT rules_negation_check CHECK(NOT negated OR relation IN ('color','material'));
ALTER TABLE knowledge.budget_rules DROP CONSTRAINT budget_rules_output_check;
ALTER TABLE knowledge.budget_rules ADD CONSTRAINT budget_rules_output_check CHECK(output IN ('maximum_price','price_range'));
CREATE OR REPLACE FUNCTION knowledge.require_reviewed_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pack jsonb; expected_count integer;
BEGIN
 SELECT artifact->'languageKnowledge' INTO pack FROM release.dictionaries WHERE id=NEW.release_id;
 IF pack ? 'ruleGovernance' THEN
  IF jsonb_typeof(pack->'ruleGovernance') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid rule governance'; END IF;
  expected_count:=jsonb_array_length(pack->'rules')+jsonb_array_length(coalesce(pack->'utteranceRules','[]'::jsonb))+jsonb_array_length(coalesce(pack->'questionRules','[]'::jsonb))+jsonb_array_length(coalesce(pack->'budgetRules','[]'::jsonb));
  IF jsonb_array_length(pack->'ruleGovernance')<>expected_count OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(pack->'ruleGovernance') r
   WHERE r->>'status' IS DISTINCT FROM 'reviewed' OR nullif(r->'review'->>'reviewer','') IS NULL
    OR coalesce(r->>'runtime','') NOT IN ('knowledge-governance-v1','knowledge-composition-v2')
  ) THEN RAISE EXCEPTION 'Activation requires complete reviewed knowledge rules'; END IF;
 ELSIF pack ? 'budgetRules' THEN RAISE EXCEPTION 'Budget rules require governance';
 END IF;
 RETURN NEW;
END $$;
CREATE VIEW knowledge.lexical_reviews AS
 SELECT p.code AS pack_code,p.revision,c.code AS concept_code,c.kind,c.canonical,a.surface,
 c.metadata->'lexicalReview' AS review,c.metadata->'domains' AS domains,c.metadata->>'usage' AS usage
 FROM knowledge.concepts c JOIN knowledge.packs p ON p.sha256=c.pack_sha256
 JOIN knowledge.aliases a ON a.pack_sha256=c.pack_sha256 AND a.concept_code=c.code;
COMMIT;
