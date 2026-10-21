-- Presentation overrides only; catalog and CMS facts remain authoritative.
CREATE TABLE cms.publication_metadata (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision integer NOT NULL DEFAULT 1,
 configuration jsonb NOT NULL DEFAULT '{"templates":{},"overrides":{},"social_image":null}',
 updated_by uuid REFERENCES admin_iam.admin_users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO cms.publication_metadata(singleton) VALUES(true);
CREATE TABLE catalog.publication_images (
 media_id uuid PRIMARY KEY REFERENCES catalog.media(id) ON DELETE CASCADE,
 width integer NOT NULL CHECK(width BETWEEN 1 AND 12000),
 height integer NOT NULL CHECK(height BETWEEN 1 AND 12000),
 variants jsonb NOT NULL DEFAULT '[]'
);
-- Read-only eligibility projection, consumed by media authorization.
CREATE VIEW catalog.public_media_ids AS
 SELECT unnest(p.media_ids) AS id FROM catalog.products p WHERE p.active AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.products parent WHERE parent.id=p.parent_id AND parent.active))
 UNION SELECT m.id FROM catalog.media m JOIN catalog.categories c ON m.id::text IN (c.attributes->>'thumbnail',c.attributes->>'banner')
 UNION SELECT m.id FROM catalog.media m JOIN cms.documents d ON true JOIN LATERAL (SELECT * FROM cms.releases WHERE document_id=d.id AND NOT cancelled AND starts_at<=transaction_timestamp() ORDER BY starts_at DESC,created_at DESC LIMIT 1) l ON true JOIN cms.revisions r ON r.id=l.revision_id CROSS JOIN LATERAL jsonb_array_elements(r.blocks) b WHERE (l.ends_at IS NULL OR l.ends_at>transaction_timestamp()) AND b->>'image_id'=m.id::text
 UNION SELECT m.id FROM catalog.media m JOIN theme.assignments a ON a.channel='storefront' JOIN theme.themes t ON t.id=a.theme_id JOIN theme.versions v ON v.id=t.published_version WHERE jsonb_path_exists(v.configuration,'$.**.image ? (@ == $id)',jsonb_build_object('id',m.id::text))
 UNION SELECT m.id FROM catalog.media m JOIN cms.publication_metadata s ON s.configuration->>'social_image'=m.id::text;
