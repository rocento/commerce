-- One published market per storefront installation. Draft changes never alter a release.
CREATE TABLE cart_checkout.market_releases (
 id uuid PRIMARY KEY,
 market_id uuid NOT NULL REFERENCES cart_checkout.market_drafts(id),
 name text NOT NULL, country text NOT NULL, currency text NOT NULL,
 source_locale text NOT NULL, draft_revision integer NOT NULL,
 created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cart_checkout.market_release_overrides (
 release_id uuid NOT NULL REFERENCES cart_checkout.market_releases(id),
 entity_type text NOT NULL CHECK(entity_type IN ('product','category','navigation')),
 entity_id uuid NOT NULL, available boolean, price numeric(12,2),
 PRIMARY KEY(release_id,entity_type,entity_id),
 CHECK(price IS NULL OR (entity_type='product' AND price>=0))
);
CREATE TABLE cart_checkout.active_market (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 release_id uuid REFERENCES cart_checkout.market_releases(id),
 revision bigint NOT NULL DEFAULT 1
);
INSERT INTO cart_checkout.active_market DEFAULT VALUES;
CREATE VIEW catalog.storefront_products AS
 SELECT (jsonb_populate_record(NULL::catalog.products, to_jsonb(p) || jsonb_build_object(
 'price',COALESCE(o.price,p.price),
 'currency',CASE WHEN o.price IS NOT NULL THEN r.currency ELSE p.currency END,
 'active',p.active AND COALESCE(o.available,true) AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.products parent LEFT JOIN cart_checkout.market_release_overrides po ON po.release_id=a.release_id AND po.entity_type='product' AND po.entity_id=parent.id WHERE parent.id=p.parent_id AND parent.active AND COALESCE(po.available,true)))))).*
 FROM catalog.products p
 CROSS JOIN cart_checkout.active_market a
 LEFT JOIN cart_checkout.market_releases r ON r.id=a.release_id
 LEFT JOIN cart_checkout.market_release_overrides o ON o.release_id=r.id AND o.entity_type='product' AND o.entity_id=p.id;
CREATE VIEW catalog.storefront_categories AS
 SELECT c.* FROM catalog.categories c
 WHERE NOT EXISTS(SELECT 1 FROM cart_checkout.active_market a JOIN cart_checkout.market_release_overrides o ON o.release_id=a.release_id WHERE o.entity_type='category' AND o.entity_id=c.id AND o.available=false);
CREATE FUNCTION cms.market_content_available(document_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT NOT EXISTS(SELECT 1 FROM cart_checkout.active_market a JOIN cart_checkout.market_release_overrides o ON o.release_id=a.release_id WHERE o.entity_type='navigation' AND o.entity_id=document_id AND o.available=false)
$$;
