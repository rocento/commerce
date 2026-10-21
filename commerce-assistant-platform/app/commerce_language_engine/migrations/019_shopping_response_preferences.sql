BEGIN;
-- Extend validated preferences without rewriting immutable published packs.
ALTER TABLE knowledge.utterance_rules DROP CONSTRAINT utterance_rules_preference_check;
ALTER TABLE knowledge.utterance_rules ADD CONSTRAINT utterance_rules_preference_check
 CHECK(preference IN ('short','explain_fit','tradeoffs','uncertainty','no_assumptions','practical_start','two_options','one_question'));
COMMIT;
