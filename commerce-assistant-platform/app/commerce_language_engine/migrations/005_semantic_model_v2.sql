BEGIN;

-- Additive authoring model. These tables are not consulted by turn-time
-- resolution until a later runtime migration explicitly enables them.
CREATE TABLE IF NOT EXISTS intent_slots (
 id bigserial PRIMARY KEY,
 intent_id bigint NOT NULL REFERENCES commerce_intents(id) ON DELETE CASCADE,
 code text NOT NULL CHECK(code ~ '^[A-Z][A-Z0-9_]*$'),
 entity_type_id bigint REFERENCES entity_types(id),
 value_type text NOT NULL CHECK(value_type IN ('TEXT','NUMBER','MONEY','DATE','TIME','BOOLEAN','ENTITY','ENUM','OBJECT')),
 requirement text NOT NULL CHECK(requirement IN ('REQUIRED','OPTIONAL','CONTEXTUAL','DERIVED')),
 min_count integer NOT NULL DEFAULT 0 CHECK(min_count>=0),
 max_count integer CHECK(max_count IS NULL OR max_count>=min_count),
 clarification_rank integer NOT NULL DEFAULT 100 CHECK(clarification_rank>=0),
 resolution_strategy text NOT NULL DEFAULT 'EXTRACT' CHECK(resolution_strategy IN ('EXTRACT','REFERENCE','COMMERCE_LOOKUP','DEFAULT','ASK_USER')),
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 UNIQUE(intent_id,code,version)
);
CREATE INDEX IF NOT EXISTS intent_slots_active_idx ON intent_slots(intent_id,clarification_rank) WHERE active;

CREATE TABLE IF NOT EXISTS semantic_relationships (
 id bigserial PRIMARY KEY,
 source_group_id bigint NOT NULL REFERENCES semantic_groups(id) ON DELETE CASCADE,
 relation_code text NOT NULL CHECK(relation_code ~ '^[A-Z][A-Z0-9_]*$'),
 target_group_id bigint NOT NULL REFERENCES semantic_groups(id) ON DELETE CASCADE,
 industry_pack_id bigint REFERENCES industry_packs(id),
 weight numeric(8,4) NOT NULL DEFAULT 1 CHECK(weight>=0),
 directional boolean NOT NULL DEFAULT true,
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
 CHECK(source_group_id<>target_group_id),
 UNIQUE(source_group_id,relation_code,target_group_id,industry_pack_id,version)
);
CREATE INDEX IF NOT EXISTS semantic_relationships_source_idx ON semantic_relationships(source_group_id,relation_code) WHERE active;
CREATE INDEX IF NOT EXISTS semantic_relationships_target_idx ON semantic_relationships(target_group_id,relation_code) WHERE active;
CREATE UNIQUE INDEX IF NOT EXISTS semantic_relationships_identity_idx ON semantic_relationships(source_group_id,relation_code,target_group_id,COALESCE(industry_pack_id,0),version);

CREATE TABLE IF NOT EXISTS semantic_composition_rules (
 id bigserial PRIMARY KEY,
 code text NOT NULL,
 left_kind text NOT NULL,
 left_ref text,
 relation text NOT NULL,
 right_kind text NOT NULL,
 right_ref text,
 output_kind text NOT NULL,
 output_template jsonb NOT NULL,
 precedence integer NOT NULL DEFAULT 100,
 score numeric(8,4) NOT NULL DEFAULT 0,
 industry_pack_id bigint REFERENCES industry_packs(id),
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(code,version)
);
CREATE INDEX IF NOT EXISTS semantic_composition_active_idx ON semantic_composition_rules(precedence,code) WHERE active;

CREATE TABLE IF NOT EXISTS action_frame_slots (
 id bigserial PRIMARY KEY,
 action_frame_id bigint NOT NULL REFERENCES action_frames(id) ON DELETE CASCADE,
 role_code text NOT NULL CHECK(role_code IN ('ACTOR','ACTION','OBJECT','QUANTITY','SOURCE','DESTINATION','DATE','TIME','SELECTION','CONSTRAINT')),
 semantic_group_id bigint REFERENCES semantic_groups(id),
 entity_type_id bigint REFERENCES entity_types(id),
 requirement text NOT NULL CHECK(requirement IN ('REQUIRED','OPTIONAL','CONTEXTUAL','DERIVED')),
 cardinality text NOT NULL DEFAULT 'ONE' CHECK(cardinality IN ('ZERO_OR_ONE','ONE','ZERO_OR_MORE','ONE_OR_MORE')),
 positional_hint jsonb NOT NULL DEFAULT '{}'::jsonb,
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 CHECK(semantic_group_id IS NOT NULL OR entity_type_id IS NOT NULL),
 UNIQUE(action_frame_id,role_code,version)
);

CREATE TABLE IF NOT EXISTS semantic_ambiguities (
 id bigserial PRIMARY KEY,
 normalized_term text NOT NULL CHECK(length(normalized_term)>0),
 candidate_kind text NOT NULL CHECK(candidate_kind IN ('INTENT','SEMANTIC_GROUP','ENTITY_TYPE','ENTITY_VALUE','OPERATOR','ACTION_FRAME')),
 candidate_ref text NOT NULL,
 industry_pack_id bigint REFERENCES industry_packs(id),
 prior_weight numeric(8,4) NOT NULL DEFAULT 1 CHECK(prior_weight>=0),
 required_context jsonb NOT NULL DEFAULT '{}'::jsonb,
 disambiguation_policy text NOT NULL DEFAULT 'SCORE' CHECK(disambiguation_policy IN ('SCORE','ASK','PREFER_CONTEXT','PREFER_INDUSTRY')),
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(normalized_term,candidate_kind,candidate_ref,industry_pack_id,version)
);
CREATE INDEX IF NOT EXISTS semantic_ambiguities_term_idx ON semantic_ambiguities(normalized_term) WHERE active;

CREATE TABLE IF NOT EXISTS reference_rules (
 id bigserial PRIMARY KEY,
 code text NOT NULL,
 reference_group_id bigint NOT NULL REFERENCES semantic_groups(id) ON DELETE CASCADE,
 target_kind text NOT NULL CHECK(target_kind IN ('ENTITY','ACTION','RESULT_SET','LOCATION','ORDER','ADDRESS')),
 selection_strategy text NOT NULL CHECK(selection_strategy IN ('LATEST_COMPATIBLE','LATEST_SINGULAR','LATEST_PLURAL','PREVIOUS_SELECTION','SAVED_REFERENCE','ASK')),
 constraints jsonb NOT NULL DEFAULT '{}'::jsonb,
 precedence integer NOT NULL DEFAULT 100,
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(code,version)
);
CREATE INDEX IF NOT EXISTS reference_rules_lookup_idx ON reference_rules(reference_group_id,precedence) WHERE active;

CREATE TABLE IF NOT EXISTS clarification_policies (
 id bigserial PRIMARY KEY,
 intent_id bigint NOT NULL REFERENCES commerce_intents(id) ON DELETE CASCADE,
 slot_code text NOT NULL,
 question_template text NOT NULL CHECK(length(trim(question_template))>0),
 candidate_mode text NOT NULL DEFAULT 'NONE' CHECK(candidate_mode IN ('NONE','ENGINE','COMMERCE','CONTEXT')),
 max_attempts integer NOT NULL DEFAULT 2 CHECK(max_attempts>0),
 priority integer NOT NULL DEFAULT 100 CHECK(priority>=0),
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 UNIQUE(intent_id,slot_code,version)
);

CREATE TABLE IF NOT EXISTS resolution_feedback (
 id bigserial PRIMARY KEY,
 utterance_hash text NOT NULL CHECK(length(utterance_hash)>0),
 dictionary_version integer NOT NULL CHECK(dictionary_version>0),
 engine_version text NOT NULL,
 predicted_intent text,
 expected_intent text,
 raw_confidence numeric(8,6) CHECK(raw_confidence IS NULL OR raw_confidence BETWEEN 0 AND 1),
 calibrated_confidence numeric(8,6) CHECK(calibrated_confidence IS NULL OR calibrated_confidence BETWEEN 0 AND 1),
 status text NOT NULL,
 accepted boolean,
 clarification_required boolean NOT NULL DEFAULT false,
 source text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resolution_feedback_eval_idx ON resolution_feedback(dictionary_version,created_at);
CREATE INDEX IF NOT EXISTS resolution_feedback_hash_idx ON resolution_feedback(utterance_hash);

CREATE TABLE IF NOT EXISTS confidence_calibrations (
 id bigserial PRIMARY KEY,
 scope_kind text NOT NULL CHECK(scope_kind IN ('GLOBAL','INTENT_FAMILY','INTENT')),
 scope_code text NOT NULL,
 dictionary_version integer NOT NULL CHECK(dictionary_version>0),
 method text NOT NULL CHECK(method IN ('IDENTITY','PLATT','ISOTONIC','TEMPERATURE','CUSTOM')),
 parameters jsonb NOT NULL,
 sample_count integer NOT NULL CHECK(sample_count>=0),
 metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
 active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(scope_kind,scope_code,dictionary_version,method)
);
CREATE INDEX IF NOT EXISTS confidence_calibration_active_idx ON confidence_calibrations(scope_kind,scope_code,dictionary_version) WHERE active;

CREATE TABLE IF NOT EXISTS industry_pack_relations (
 parent_pack_id bigint NOT NULL REFERENCES industry_packs(id) ON DELETE CASCADE,
 child_pack_id bigint NOT NULL REFERENCES industry_packs(id) ON DELETE CASCADE,
 inherit_terms boolean NOT NULL DEFAULT true,
 inherit_rules boolean NOT NULL DEFAULT true,
 inherit_entities boolean NOT NULL DEFAULT true,
 inherit_relationships boolean NOT NULL DEFAULT true,
 precedence integer NOT NULL DEFAULT 100,
 PRIMARY KEY(parent_pack_id,child_pack_id),
 CHECK(parent_pack_id<>child_pack_id)
);

COMMIT;
