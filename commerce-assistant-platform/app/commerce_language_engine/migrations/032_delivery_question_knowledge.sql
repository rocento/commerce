BEGIN;
ALTER TABLE knowledge.question_rules DROP CONSTRAINT question_rules_intent_check;
ALTER TABLE knowledge.question_rules ADD CONSTRAINT question_rules_intent_check CHECK(intent IN ('PRODUCT_SEARCH','PRODUCT_DETAILS','CHECK_PRICE','CHECK_STOCK','PRODUCT_COMPARE','PRODUCT_COMPATIBILITY','PRODUCT_WARRANTY','PRODUCT_MATERIAL','PRODUCT_INGREDIENTS','PRODUCT_ALLERGENS','PRODUCT_ORIGIN','PRODUCT_STORAGE','PRODUCT_CERTIFICATION','PRODUCT_BATTERY_LIFE','PRODUCT_SIZE_GUIDE','RETURN_POLICY','DELIVERY_DATE'));
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
    OR coalesce(r->>'runtime','') NOT IN ('knowledge-governance-v1','knowledge-composition-v2','knowledge-composition-v3','knowledge-delivery-questions-v4')
  ) THEN RAISE EXCEPTION 'Activation requires complete reviewed knowledge rules'; END IF;
 ELSIF pack ? 'budgetRules' THEN RAISE EXCEPTION 'Budget rules require governance';
 END IF;
 RETURN NEW;
END $$;
COMMIT;
