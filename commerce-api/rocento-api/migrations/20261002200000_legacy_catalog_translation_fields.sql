-- Include legacy product text attributes without changing applied migration history.
CREATE OR REPLACE FUNCTION cms.catalog_text_translation_source(entity text, attrs jsonb)
RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT coalesce(jsonb_object_agg('attribute.'||d.attribute_code, attrs->>d.attribute_code), '{}'::jsonb)
   || coalesce(jsonb_object_agg('__label.attribute.'||d.attribute_code, d.label), '{}'::jsonb)
 FROM (
   SELECT attribute_code,label FROM attributes.definitions
   WHERE entity_type=entity AND input_type IN ('text','textarea','long_text')
   UNION ALL
   SELECT code,name FROM catalog.attributes a WHERE entity='product' AND kind='text'
     AND NOT EXISTS(SELECT 1 FROM attributes.definitions d WHERE d.entity_type='product' AND d.attribute_code=a.code)
 ) d
 WHERE jsonb_typeof(attrs->d.attribute_code)='string';
$$;
