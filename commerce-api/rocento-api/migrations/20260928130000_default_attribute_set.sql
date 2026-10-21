-- Adobe Commerce reference: a general-purpose Default set, with optional fields.
-- Core product fields (SKU, name, description, price, status, category and media)
-- already have dedicated storage/editors and must not be duplicated in JSON.
-- https://experienceleague.adobe.com/en/docs/commerce-admin/catalog/product-attributes/create/attribute-sets
-- https://experienceleague.adobe.com/en/docs/commerce-admin/systems/data-transfer/data-attributes-product
CREATE TEMP TABLE default_product_attributes ON COMMIT DROP AS
SELECT * FROM (VALUES
 ('short_description', 'Short description', 'textarea', 'Content', 10, true, true, '{"max_length":4000}'::jsonb),
 ('manufacturer', 'Manufacturer', 'text', 'General', 10, true, true, '{"max_length":255}'::jsonb),
 ('country_of_manufacture', 'Country of manufacture', 'text', 'General', 20, true, false, '{"max_length":100}'::jsonb),
 ('weight', 'Weight (kg)', 'measurement', 'Shipping', 10, false, false, '{"unit":"kg","min":0}'::jsonb),
 ('meta_title', 'Meta title', 'text', 'Search Engine Optimization', 10, false, false, '{"max_length":255}'::jsonb),
 ('meta_keyword', 'Meta keywords', 'textarea', 'Search Engine Optimization', 20, false, false, '{"max_length":1000}'::jsonb),
 ('meta_description', 'Meta description', 'textarea', 'Search Engine Optimization', 30, false, false, '{"max_length":255}'::jsonb)
) AS defaults(code,label,input_type,group_name,position,visible,searchable,metadata);

-- Keep merchant definitions, including their IDs, types and validation settings.
INSERT INTO attributes.definitions
 (id,entity_type,attribute_code,label,input_type,is_visible_on_front,is_searchable,metadata)
SELECT gen_random_uuid(),'product',code,label,input_type,visible,searchable,
 metadata || jsonb_build_object('display_order',position,'ai_queryable',visible)
FROM default_product_attributes
ON CONFLICT(entity_type,attribute_code) DO NOTHING;

INSERT INTO attributes.sets(id,name,description)
VALUES(gen_random_uuid(),'Default','General-purpose product attributes inspired by Adobe Commerce. Core product fields are managed in the standard product editor.')
ON CONFLICT(name) DO NOTHING;

-- Append missing members without disturbing merchant groups or positions.
INSERT INTO attributes.set_members(set_id,definition_id,group_name,position)
SELECT s.id,d.id,a.group_name,
 COALESCE((SELECT max(m.position) FROM attributes.set_members m
           WHERE m.set_id=s.id AND m.group_name=a.group_name),0) + a.position
FROM default_product_attributes a
JOIN attributes.definitions d ON d.entity_type='product' AND d.attribute_code=a.code
CROSS JOIN attributes.sets s
WHERE s.name='Default'
ON CONFLICT(set_id,definition_id) DO NOTHING;

-- Bootstrap the existing product-editor default selector; retain chosen profiles.
UPDATE attributes.catalog_configuration
SET default_attribute_set_id=(SELECT id FROM attributes.sets WHERE name='Default'),
 updated_at=clock_timestamp()
WHERE singleton AND default_attribute_set_id IS NULL;

INSERT INTO platform.outbox(id,event_type,payload)
VALUES(gen_random_uuid(),'catalog.attribute_definition_updated',
 '{"entity_type":"product","reason":"default_attribute_set"}'::jsonb);
