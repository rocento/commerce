BEGIN;
-- Devices name compatibility targets, never asserted accessory specifications.
ALTER TABLE knowledge.concepts DROP CONSTRAINT concepts_kind_check;
ALTER TABLE knowledge.concepts ADD CONSTRAINT concepts_kind_check CHECK(kind IN ('color','country','person','activity','occasion','device'));
ALTER TABLE knowledge.rules DROP CONSTRAINT rules_target_kind_check;
ALTER TABLE knowledge.rules ADD CONSTRAINT rules_target_kind_check CHECK(target_kind IN ('color','country','person','activity','occasion','device'));
ALTER TABLE knowledge.rules DROP CONSTRAINT rules_relation_check;
ALTER TABLE knowledge.rules ADD CONSTRAINT rules_relation_check CHECK(relation IN ('intended_use','recipient','audience','occasion','color','origin_country','destination_country','market_country','compatibility_target'));
ALTER TABLE knowledge.utterance_rules DROP CONSTRAINT utterance_rules_role_check;
ALTER TABLE knowledge.utterance_rules ADD CONSTRAINT utterance_rules_role_check CHECK(role IN ('background','search_prompt','response_preference','budget_update','recommendation_followup'));
ALTER TABLE knowledge.utterance_rules ADD COLUMN reference text;
ALTER TABLE knowledge.utterance_rules ADD CONSTRAINT utterance_rules_reference_check CHECK((role='recommendation_followup' AND reference IS NOT NULL AND reference='FIRST') OR (role<>'recommendation_followup' AND reference IS NULL));
COMMIT;
