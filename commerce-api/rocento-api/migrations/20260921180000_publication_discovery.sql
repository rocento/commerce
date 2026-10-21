-- Provider-specific preferences; independent optimistic revision and audit trail.
CREATE TABLE cms.publication_crawlers (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 openai_search boolean NOT NULL DEFAULT true,
 openai_training boolean NOT NULL DEFAULT false
);
INSERT INTO cms.publication_crawlers(singleton) VALUES(true);
-- A projection of public routes, not a duplicate product catalogue.
-- Catalog updated_at includes administrative changes; do not pretend it is public lastmod.
CREATE VIEW platform.publication_sitemap_resources AS
 SELECT 'products'::text AS kind,p.id,'/products/'||p.slug AS path,NULL::timestamptz AS lastmod
 FROM catalog.products p LEFT JOIN catalog.products parent ON parent.id=p.parent_id
 WHERE p.active AND (p.parent_id IS NULL OR parent.active)
 UNION ALL
 SELECT 'categories',id,'/categories/'||slug,NULL::timestamptz FROM catalog.categories
 UNION ALL
 SELECT 'content',d.id,'/pages/'||d.key,l.starts_at
 FROM cms.documents d JOIN LATERAL (
 SELECT * FROM cms.releases WHERE document_id=d.id AND NOT cancelled
 AND starts_at<=transaction_timestamp() ORDER BY starts_at DESC,created_at DESC LIMIT 1
 ) l ON true JOIN cms.revisions r ON r.id=l.revision_id
 WHERE d.key<>'home' AND (l.ends_at IS NULL OR l.ends_at>transaction_timestamp());
