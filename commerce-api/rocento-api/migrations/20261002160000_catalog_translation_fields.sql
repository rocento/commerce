-- Keep localized copy separate from shared catalog data and stable option values.
ALTER TABLE cms.catalog_translations DROP CONSTRAINT catalog_translations_entity_type_check;
ALTER TABLE cms.catalog_translations ADD CONSTRAINT catalog_translations_entity_type_check
 CHECK (entity_type IN ('product','category','navigation','attribute'));

CREATE FUNCTION cms.catalog_text_translation_source(entity text, attrs jsonb)
RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_object_agg('attribute.'||d.attribute_code, attrs->>d.attribute_code), '{}'::jsonb)
   || coalesce(jsonb_object_agg('__label.attribute.'||d.attribute_code, d.label), '{}'::jsonb)
 FROM attributes.definitions d
 WHERE d.entity_type=entity AND d.input_type IN ('text','textarea','long_text')
   AND jsonb_typeof(attrs->d.attribute_code)='string';
$$;

CREATE FUNCTION cms.attribute_translation_source(label text, metadata jsonb, options jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
 SELECT jsonb_build_object('label',label,'description',coalesce(metadata->>'description',''))
   || coalesce((SELECT jsonb_object_agg('option.'||(o->>'value'),o->>'label')
      FROM jsonb_array_elements(options) o), '{}'::jsonb);
$$;

CREATE OR REPLACE VIEW cms.translation_sources AS
 SELECT 'product'::text AS entity_type,id AS entity_id,name,
 jsonb_build_object('name',name,'description',description)
   || cms.catalog_text_translation_source('product',attributes) AS source FROM catalog.products
 UNION ALL
 SELECT 'category'::text,id,name,jsonb_build_object('name',name)
   || cms.catalog_text_translation_source('category',attributes) FROM catalog.categories
 UNION ALL
 SELECT 'navigation'::text,d.id,r.title,cms.navigation_translation_source(r.title,r.blocks,d.version)
 FROM cms.documents d JOIN cms.revisions r ON r.document_id=d.id AND r.version=d.version
 WHERE d.kind='navigation'
 UNION ALL
 SELECT 'attribute'::text,id,label,cms.attribute_translation_source(label,metadata,options)
 FROM attributes.definitions WHERE entity_type IN ('product','category');

-- Read legacy inline labels until the first explicit translation save. This does
-- not invent a reviewer or change the original attribute definition.
CREATE FUNCTION cms.attribute_legacy_translation_fields(definition_id uuid, locale text)
RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_object_agg('option.'||(o->>'value'),o->'labels'->>locale), '{}'::jsonb)
 FROM attributes.definitions d CROSS JOIN LATERAL jsonb_array_elements(d.options) o
 WHERE d.id=definition_id AND jsonb_typeof(o->'labels'->locale)='string';
$$;
