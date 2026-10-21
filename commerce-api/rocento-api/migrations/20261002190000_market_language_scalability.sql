-- Keep identity/filter columns visible to the planner. A whole-row JSON round trip
-- hides product ID/slug/category indexes and repeats serialization per output column.
-- Preserve the column order and numeric typmod of the existing public read model.
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE VIEW catalog.storefront_products AS
 SELECT p.id,p.sku,p.slug,p.name,p.description,
 COALESCE(o.price,p.price)::numeric(12,2) AS price,
 CASE WHEN o.price IS NOT NULL THEN r.currency ELSE p.currency END AS currency,
 p.unit,p.category_id,p.attributes,p.media_ids,
 p.active AND COALESCE(o.available,true) AND
   (p.parent_id IS NULL OR EXISTS(
     SELECT 1 FROM catalog.products parent
     LEFT JOIN cart_checkout.market_release_overrides po
       ON po.release_id=a.release_id AND po.entity_type='product' AND po.entity_id=parent.id
     WHERE parent.id=p.parent_id AND parent.active AND COALESCE(po.available,true)
   )) AS active,
 p.in_stock,p.updated_at,p.product_type,p.parent_id,p.variant_attributes,
 p.attribute_set_id,p.category_ids
 FROM catalog.products p
 -- LIMIT reflects the enforced singleton and avoids inflated estimates/JIT on
 -- fresh installations before autovacuum has collected table statistics.
 CROSS JOIN (SELECT release_id FROM cart_checkout.active_market WHERE singleton LIMIT 1) a
 LEFT JOIN cart_checkout.market_releases r ON r.id=a.release_id
 LEFT JOIN cart_checkout.market_release_overrides o
   ON o.release_id=r.id AND o.entity_type='product' AND o.entity_id=p.id;

-- Match the API's canonical language[-Script][-REGION] subset at the DB boundary.
-- This is deliberately not a claim to accept every possible BCP-47 tag.
CREATE FUNCTION cms.is_canonical_locale(locale text) RETURNS boolean
 LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT locale ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-([A-Z]{2}|[0-9]{3}))?$'
$$;
CREATE FUNCTION cms.valid_market_locales(locales text[]) RETURNS boolean
 LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT coalesce(array_ndims(locales)=1
   AND cardinality(locales) BETWEEN 1 AND 20
   AND cardinality(locales)=count(DISTINCT locale)
   AND bool_and(cms.is_canonical_locale(locale)),false)
 FROM unnest(locales) AS l(locale)
$$;
ALTER TABLE cms.storefront_languages ADD CONSTRAINT storefront_languages_canonical_locale
 CHECK(cms.is_canonical_locale(locale));
ALTER TABLE cms.language_settings ADD CONSTRAINT language_settings_canonical_locale
 CHECK(cms.is_canonical_locale(source_locale));
ALTER TABLE cms.navigation_release_translations ADD CONSTRAINT navigation_release_canonical_locale
 CHECK(cms.is_canonical_locale(locale));
ALTER TABLE cart_checkout.market_drafts ADD CONSTRAINT market_drafts_valid_locales
 CHECK(cms.valid_market_locales(locales) AND cms.is_canonical_locale(default_locale));
ALTER TABLE cart_checkout.market_releases
 ADD CONSTRAINT market_releases_canonical_locale CHECK(cms.is_canonical_locale(source_locale)),
 ADD CONSTRAINT market_releases_positive_revision CHECK(draft_revision>0),
 ADD CONSTRAINT market_releases_created_by_fk FOREIGN KEY(created_by) REFERENCES admin_iam.admin_users(id);
ALTER TABLE cart_checkout.active_market ADD CONSTRAINT active_market_positive_revision CHECK(revision>0);

-- Support release history/FK lookups and publication invalidation as history grows.
CREATE INDEX market_releases_history ON cart_checkout.market_releases(market_id,created_at DESC,id);
CREATE INDEX carts_market ON cart_checkout.carts(market_id) WHERE market_id IS NOT NULL;
CREATE INDEX quotes_expiry ON cart_checkout.quotes(expires_at);
CREATE INDEX basket_proposals_expiry ON cart_checkout.basket_proposals(expires_at);
