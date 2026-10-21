-- Append the route key without editing the already-deployed discovery migration.
-- The later publication-feeds migration retains this column and adds freshness data.
CREATE OR REPLACE VIEW platform.publication_sitemap_resources AS
 SELECT 'products'::text AS kind,p.id,'/products/'||p.slug AS path,NULL::timestamptz AS lastmod,p.slug AS route_key
 FROM catalog.products p LEFT JOIN catalog.products parent ON parent.id=p.parent_id
 WHERE p.active AND (p.parent_id IS NULL OR parent.active)
 UNION ALL
 SELECT 'categories',id,'/categories/'||slug,NULL::timestamptz,slug FROM catalog.categories
 UNION ALL
 SELECT 'content',d.id,'/pages/'||d.key,l.starts_at,d.key
 FROM cms.documents d JOIN LATERAL (
 SELECT * FROM cms.releases WHERE document_id=d.id AND NOT cancelled
 AND starts_at<=transaction_timestamp() ORDER BY starts_at DESC,created_at DESC LIMIT 1
 ) l ON true JOIN cms.revisions r ON r.id=l.revision_id
 WHERE d.key<>'home' AND (l.ends_at IS NULL OR l.ends_at>transaction_timestamp());
