BEGIN;
ALTER TABLE knowledge.utterance_rules DROP CONSTRAINT utterance_rules_role_check;
ALTER TABLE knowledge.utterance_rules ADD CONSTRAINT utterance_rules_role_check CHECK(role IN ('background','search_prompt','response_preference','budget_update','recommendation_followup','lead_in'));
-- Literal templates are reviewed, versioned with the pack, and never executed as SQL or code.
CREATE TABLE knowledge.question_rules (
 pack_sha256 text NOT NULL REFERENCES knowledge.packs(sha256),
 code text NOT NULL,
 intent text NOT NULL CHECK(intent IN ('PRODUCT_SEARCH','PRODUCT_DETAILS','CHECK_PRICE','CHECK_STOCK','PRODUCT_COMPARE','PRODUCT_COMPATIBILITY','PRODUCT_WARRANTY','PRODUCT_MATERIAL','PRODUCT_INGREDIENTS','PRODUCT_ALLERGENS','PRODUCT_ORIGIN','PRODUCT_STORAGE','PRODUCT_CERTIFICATION','PRODUCT_BATTERY_LIFE','PRODUCT_SIZE_GUIDE','RETURN_POLICY')),
 templates jsonb NOT NULL CHECK(jsonb_typeof(templates)='array' AND jsonb_array_length(templates)>0),
 PRIMARY KEY(pack_sha256,code)
);
CREATE TRIGGER knowledge_question_rule_immutable BEFORE UPDATE OR DELETE ON knowledge.question_rules FOR EACH ROW EXECUTE FUNCTION knowledge.reject_pack_mutation();
COMMIT;
