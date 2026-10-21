ALTER TABLE cms.catalog_translations DROP CONSTRAINT catalog_translations_entity_type_check;
ALTER TABLE cms.catalog_translations ADD CONSTRAINT catalog_translations_entity_type_check CHECK (entity_type IN ('product','category','navigation'));

-- Flatten only customer-facing text. The revision guards position-based menu keys
-- against reordered items or changed destinations in a later source revision.
CREATE FUNCTION cms.navigation_translation_source(title text, blocks jsonb, version integer)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
 result jsonb := jsonb_build_object('title', title, '__version', version::text);
 item jsonb; link jsonb; i integer := 0; j integer;
BEGIN
 FOR item IN SELECT value FROM jsonb_array_elements(blocks) LOOP
  result := result || jsonb_build_object('item.'||i||'.label',coalesce(item->>'link_label',''), 'item.'||i||'.badge',coalesce(item->'navigation'->>'badge',''));
  j := 0;
  FOR link IN SELECT value FROM jsonb_array_elements(coalesce(item->'navigation'->'links','[]'::jsonb)) LOOP
   result := result || jsonb_build_object('item.'||i||'.link.'||j||'.label',coalesce(link->>'label',''), 'item.'||i||'.link.'||j||'.group',coalesce(link->>'group',''), 'item.'||i||'.link.'||j||'.description',coalesce(link->>'description',''));
   j := j + 1;
  END LOOP;
  i := i + 1;
 END LOOP;
 RETURN result;
END $$;

CREATE OR REPLACE VIEW cms.translation_sources AS
 SELECT 'product'::text AS entity_type, id AS entity_id, name,
 jsonb_build_object('name',name,'description',description) AS source FROM catalog.products
 UNION ALL
 SELECT 'category'::text, id, name, jsonb_build_object('name',name) FROM catalog.categories
 UNION ALL
 SELECT 'navigation'::text,d.id,r.title,cms.navigation_translation_source(r.title,r.blocks,d.version)
 FROM cms.documents d JOIN cms.revisions r ON r.document_id=d.id AND r.version=d.version
 WHERE d.kind='navigation';
