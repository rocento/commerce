BEGIN;
-- Reviewed full-sentence forms share the immutable vocabulary release lifecycle.
CREATE TABLE knowledge.utterance_rules (
 pack_sha256 text NOT NULL REFERENCES knowledge.packs(sha256),
 code text NOT NULL,
 role text NOT NULL CHECK(role IN ('background','search_prompt','response_preference','budget_update')),
 phrases jsonb NOT NULL CHECK(jsonb_typeof(phrases)='array' AND jsonb_array_length(phrases)>0),
 preference text CHECK(preference IN ('short','explain_fit','tradeoffs','uncertainty','no_assumptions','practical_start')),
 PRIMARY KEY(pack_sha256,code),
 CHECK((role='response_preference' AND preference IS NOT NULL) OR (role<>'response_preference' AND preference IS NULL))
);
CREATE TRIGGER knowledge_utterance_rule_immutable BEFORE UPDATE OR DELETE ON knowledge.utterance_rules FOR EACH ROW EXECUTE FUNCTION knowledge.reject_pack_mutation();
COMMIT;
