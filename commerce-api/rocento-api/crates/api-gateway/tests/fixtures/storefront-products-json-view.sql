-- Snapshot of the storefront view observed at the start of the 2026-10-02 review.
-- Test-only baseline: do not use this JSON projection in application queries.
CREATE VIEW catalog.legacy_storefront_products AS
 SELECT (jsonb_populate_record(NULL::catalog.products, to_jsonb(p) || jsonb_build_object(
 'price',COALESCE(o.price,p.price),
 'currency',CASE WHEN o.price IS NOT NULL THEN r.currency ELSE p.currency END,
 'active',p.active AND COALESCE(o.available,true) AND (p.parent_id IS NULL OR EXISTS(SELECT 1 FROM catalog.products parent LEFT JOIN cart_checkout.market_release_overrides po ON po.release_id=a.release_id AND po.entity_type='product' AND po.entity_id=parent.id WHERE parent.id=p.parent_id AND parent.active AND COALESCE(po.available,true)))))).*
 FROM catalog.products p
 CROSS JOIN cart_checkout.active_market a
 LEFT JOIN cart_checkout.market_releases r ON r.id=a.release_id
 LEFT JOIN cart_checkout.market_release_overrides o ON o.release_id=r.id AND o.entity_type='product' AND o.entity_id=p.id;
