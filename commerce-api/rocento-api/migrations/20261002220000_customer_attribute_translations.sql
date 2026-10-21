-- Share the attribute translation workflow across catalog and customer definitions.
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
 FROM attributes.definitions WHERE entity_type IN ('product','category','customer');
