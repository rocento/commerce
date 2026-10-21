-- Human-readable identifiers are installation-local and scoped to an entity table.
-- Existing UUID primary keys, foreign keys and polymorphic UUID references remain
-- authoritative. ADD IDENTITY fills existing rows without issuing UPDATEs, so
-- immutable published versions and cart revision triggers are not disturbed.
SET LOCAL lock_timeout = '5s';

CREATE FUNCTION platform.immutable_entity_id() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.entity_id IS DISTINCT FROM OLD.entity_id THEN
  RAISE EXCEPTION 'entity_id is immutable' USING ERRCODE = '23514';
 END IF;
 RETURN NEW;
END
$$;

DO $$
DECLARE
 entity_table text;
 entity_schema text;
 entity_name text;
BEGIN
 -- This is deliberately an allowlist of business entities, not every UUID column.
 -- Settings, sessions, ledgers, events, receipts, projections and junctions keep
 -- their existing keys. Existing UUID columns named entity_id are references.
 FOREACH entity_table IN ARRAY ARRAY[
  'admin_iam.admin_users',
  'admin_iam.roles',
  'attributes.definitions',
  'attributes.sets',
  'attributes.industry_profiles',
  'attributes.value_relationships',
  'attributes.enrichment_suggestions',
  'catalog.products',
  'catalog.categories',
  'catalog.attributes',
  'catalog.media',
  'catalog.media_folders',
  'catalog.product_configurations',
  'customers.customers',
  'customers.customer_locations',
  'customers.segments',
  'inventory.inventory_sources',
  'inventory.stocks',
  'inventory.delivery_areas',
  'cart_checkout.carts',
  'cart_checkout.quotes',
  'cart_checkout.market_drafts',
  'cart_checkout.market_releases',
  'cart_checkout.trust_agents',
  'orders.orders',
  'payments.manual_refunds',
  'tax.rules',
  'pricing_promotions.rules',
  'fulfillment.shipments',
  'fulfillment.stores',
  'fulfillment.schedules',
  'fulfillment.capacity_rules',
  'fulfillment.capacity_reservations',
  'fulfillment.plans',
  'fulfillment.plan_groups',
  'support.tickets',
  'support.messages',
  'cms.documents',
  'cms.revisions',
  'cms.releases',
  'reviews.reviews',
  'theme.themes',
  'theme.versions'
 ] LOOP
  entity_schema := split_part(entity_table, '.', 1);
  entity_name := split_part(entity_table, '.', 2);
  -- PostgreSQL allocates independently for each table. Both the sequence and
  -- CHECK stop at JavaScript's largest exactly representable integer.
  EXECUTE format(
   'ALTER TABLE %I.%I ADD COLUMN entity_id bigint GENERATED ALWAYS AS IDENTITY
    (MINVALUE 1 MAXVALUE 9007199254740991 NO CYCLE)
    UNIQUE CHECK (entity_id BETWEEN 1 AND 9007199254740991)',
   entity_schema, entity_name
  );
  EXECUTE format(
   'CREATE TRIGGER entity_id_immutable BEFORE UPDATE OF entity_id ON %I.%I
    FOR EACH ROW EXECUTE FUNCTION platform.immutable_entity_id()',
   entity_schema, entity_name
  );
  EXECUTE format(
   'COMMENT ON COLUMN %I.%I.entity_id IS %L',
   entity_schema, entity_name,
   'Immutable installation-local identifier scoped to this entity table; UUID id remains the primary and relationship key. Gaps are expected.'
  );
 END LOOP;
END
$$;

-- Append the new column while retaining every existing view column ordinal and
-- the planner-visible market projection. Views do not expand an old SELECT *
-- automatically when a base table gains a column.
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
 p.attribute_set_id,p.category_ids,p.entity_id
 FROM catalog.products p
 CROSS JOIN (SELECT release_id FROM cart_checkout.active_market WHERE singleton LIMIT 1) a
 LEFT JOIN cart_checkout.market_releases r ON r.id=a.release_id
 LEFT JOIN cart_checkout.market_release_overrides o
   ON o.release_id=r.id AND o.entity_type='product' AND o.entity_id=p.id;

CREATE OR REPLACE VIEW catalog.storefront_categories AS
 SELECT c.* FROM catalog.categories c
 WHERE NOT EXISTS(
  SELECT 1 FROM cart_checkout.active_market a
  JOIN cart_checkout.market_release_overrides o ON o.release_id=a.release_id
  WHERE o.entity_type='category' AND o.entity_id=c.id AND o.available=false
 );
