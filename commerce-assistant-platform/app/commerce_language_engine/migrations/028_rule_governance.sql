-- Rule review and executable templates are immutable members of an existing pack.
CREATE TABLE knowledge.budget_rules (
 pack_sha256 text NOT NULL REFERENCES knowledge.packs(sha256),
 code text NOT NULL,
 templates jsonb NOT NULL CHECK (jsonb_typeof(templates)='array' AND jsonb_array_length(templates) BETWEEN 1 AND 100),
 priority integer NOT NULL CHECK (priority BETWEEN 0 AND 10000),
 output text NOT NULL CHECK (output='maximum_price'),
 scope text NOT NULL CHECK (scope='product'),
 PRIMARY KEY(pack_sha256,code)
);
CREATE TABLE knowledge.rule_governance (
 pack_sha256 text NOT NULL REFERENCES knowledge.packs(sha256),
 family text NOT NULL CHECK (family IN ('relationship','utterance','question','budget')),
 rule_code text NOT NULL,
 rule_version integer NOT NULL CHECK (rule_version>0),
 definition_sha256 text NOT NULL CHECK (definition_sha256 ~ '^[a-f0-9]{64}$'),
 record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
 PRIMARY KEY(pack_sha256,family,rule_code),
 CHECK (record->>'family'=family AND record->>'ruleId'=rule_code AND (record->>'version')::integer=rule_version AND record->>'definitionSha256'=definition_sha256)
);
CREATE FUNCTION knowledge.validate_governance_reference() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE found_rule boolean;
BEGIN
 CASE NEW.family
 WHEN 'relationship' THEN SELECT EXISTS(SELECT 1 FROM knowledge.rules WHERE pack_sha256=NEW.pack_sha256 AND code=NEW.rule_code) INTO found_rule;
 WHEN 'utterance' THEN SELECT EXISTS(SELECT 1 FROM knowledge.utterance_rules WHERE pack_sha256=NEW.pack_sha256 AND code=NEW.rule_code) INTO found_rule;
 WHEN 'question' THEN SELECT EXISTS(SELECT 1 FROM knowledge.question_rules WHERE pack_sha256=NEW.pack_sha256 AND code=NEW.rule_code) INTO found_rule;
 WHEN 'budget' THEN SELECT EXISTS(SELECT 1 FROM knowledge.budget_rules WHERE pack_sha256=NEW.pack_sha256 AND code=NEW.rule_code) INTO found_rule;
 END CASE;
 IF NOT found_rule THEN RAISE EXCEPTION 'Governance references an unknown rule'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER governance_reference BEFORE INSERT ON knowledge.rule_governance FOR EACH ROW EXECUTE FUNCTION knowledge.validate_governance_reference();
CREATE TRIGGER budget_rules_immutable BEFORE UPDATE OR DELETE ON knowledge.budget_rules FOR EACH ROW EXECUTE FUNCTION knowledge.reject_pack_mutation();
CREATE TRIGGER rule_governance_immutable BEFORE UPDATE OR DELETE ON knowledge.rule_governance FOR EACH ROW EXECUTE FUNCTION knowledge.reject_pack_mutation();
CREATE VIEW knowledge.rule_reviews AS
 SELECT g.pack_sha256,p.code AS pack_code,p.revision AS pack_revision,g.family,g.rule_code,g.rule_version,
 g.record->>'status' AS review_status,g.record->>'author' AS author,g.record->>'source' AS source,
 g.record->'review'->>'reviewer' AS reviewer,g.record->'review'->>'method' AS review_method,
 g.record->>'runtime' AS required_runtime,g.record->'contract' AS applicability,
 g.record->'examples' AS examples,g.record->'counterexamples' AS counterexamples
 FROM knowledge.rule_governance g JOIN knowledge.packs p ON p.sha256=g.pack_sha256;

-- Older operator code must not activate a newer draft pack accidentally.
CREATE FUNCTION knowledge.require_reviewed_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pack jsonb; expected_count integer;
BEGIN
 SELECT artifact->'languageKnowledge' INTO pack FROM release.dictionaries WHERE id=NEW.release_id;
 IF pack ? 'ruleGovernance' THEN
  IF jsonb_typeof(pack->'ruleGovernance') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid rule governance'; END IF;
  expected_count:=jsonb_array_length(pack->'rules')+jsonb_array_length(coalesce(pack->'utteranceRules','[]'::jsonb))+jsonb_array_length(coalesce(pack->'questionRules','[]'::jsonb))+jsonb_array_length(coalesce(pack->'budgetRules','[]'::jsonb));
  IF jsonb_array_length(pack->'ruleGovernance')<>expected_count OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(pack->'ruleGovernance') r
   WHERE r->>'status' IS DISTINCT FROM 'reviewed' OR nullif(r->'review'->>'reviewer','') IS NULL
    OR r->>'runtime' IS DISTINCT FROM 'knowledge-governance-v1'
  ) THEN RAISE EXCEPTION 'Activation requires complete reviewed knowledge rules'; END IF;
 ELSIF pack ? 'budgetRules' THEN RAISE EXCEPTION 'Budget rules require governance';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER knowledge_activation_review BEFORE INSERT OR UPDATE ON release.channels FOR EACH ROW EXECUTE FUNCTION knowledge.require_reviewed_activation();
