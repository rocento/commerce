-- Catalog-scoped tables: every installation has its own catalog database.
ALTER TABLE attributes.definitions ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
-- Preserve previously public assistant context through an explicit one-time opt-in.
UPDATE attributes.definitions SET metadata=jsonb_build_object('ai_queryable',is_visible_on_front OR used_for_configurations);
UPDATE attributes.definitions SET metadata=metadata || '{"semantic_role":"classification"}' WHERE entity_type='product' AND attribute_code='product-kind';
CREATE INDEX product_attribute_values_gin ON catalog.products USING gin(attributes jsonb_path_ops);
CREATE TABLE attributes.industry_profiles (
 id uuid PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, description text NOT NULL,
 status text NOT NULL CHECK(status IN ('active','disabled')), version integer NOT NULL,
 metadata jsonb NOT NULL DEFAULT '{}', template jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE attributes.catalog_configuration (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), industry_profile_id uuid REFERENCES attributes.industry_profiles(id),
 default_attribute_set_id uuid REFERENCES attributes.sets(id) ON DELETE RESTRICT,
 version integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO attributes.catalog_configuration(singleton) VALUES(true);
CREATE TABLE attributes.value_provenance (
 product_id uuid NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
 definition_id uuid NOT NULL REFERENCES attributes.definitions(id) ON DELETE RESTRICT,
 source text NOT NULL CHECK(source IN ('VERIFIED','MERCHANT','IMPORTED','DERIVED','AI_INFERRED')),
 confidence double precision CHECK(confidence>=0 AND confidence<=1), model_version text,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(product_id,definition_id)
);
INSERT INTO attributes.value_provenance(product_id,definition_id,source)
 SELECT p.id,d.id,'MERCHANT' FROM catalog.products p JOIN attributes.definitions d ON d.entity_type='product' AND p.attributes ? d.attribute_code;
CREATE TABLE attributes.value_relationships (
 id uuid PRIMARY KEY, definition_id uuid NOT NULL REFERENCES attributes.definitions(id), value_code text NOT NULL,
 target_definition_id uuid NOT NULL REFERENCES attributes.definitions(id), target_value_code text NOT NULL,
 relation text NOT NULL CHECK(relation IN ('synonym','parent','child','related','equivalent','broader_than','narrower_than')),
 UNIQUE(definition_id,value_code,target_definition_id,target_value_code,relation)
);
CREATE TABLE attributes.enrichment_suggestions (
 id uuid PRIMARY KEY, product_id uuid NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
 definition_id uuid NOT NULL REFERENCES attributes.definitions(id), value jsonb NOT NULL,
 source text NOT NULL CHECK(source IN ('AI_INFERRED','DERIVED')), confidence double precision NOT NULL CHECK(confidence>=0 AND confidence<=1),
 model_version text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), reviewed_at timestamptz,
 reviewed_by uuid REFERENCES admin_iam.admin_users(id)
);
CREATE INDEX enrichment_pending ON attributes.enrichment_suggestions(status,created_at,id);

-- Existing installations need the new facet/sort/public projection in their current index.
-- Reuse the durable metadata-change consumer, which walks product IDs in bounded batches.
INSERT INTO platform.outbox(id,event_type,payload)
 SELECT gen_random_uuid(),'catalog.attribute_definition_updated','{"entity_type":"product","reason":"catalog_schema_upgrade"}'::jsonb
 WHERE EXISTS(SELECT 1 FROM catalog.products);
