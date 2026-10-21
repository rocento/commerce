-- Additive store contexts; legacy carts stay in the existing installation's store.
CREATE TABLE fulfillment.stores (
 id uuid PRIMARY KEY, name text NOT NULL, is_default boolean NOT NULL DEFAULT false,
 enabled boolean NOT NULL DEFAULT true, capabilities jsonb NOT NULL DEFAULT '{}',
 CHECK(jsonb_typeof(capabilities)='object')
);
CREATE UNIQUE INDEX fulfillment_default_store ON fulfillment.stores(is_default) WHERE is_default;
INSERT INTO fulfillment.stores(id,name,is_default) SELECT store_id,'Default store',true FROM cart_checkout.execution_config;
CREATE TABLE fulfillment.system_capabilities(id boolean PRIMARY KEY DEFAULT true CHECK(id), capabilities jsonb NOT NULL DEFAULT '{}');
INSERT INTO fulfillment.system_capabilities(id) VALUES(true);
CREATE TABLE fulfillment.store_sources (
 store_id uuid REFERENCES fulfillment.stores(id), source_id uuid REFERENCES inventory.inventory_sources(id),
 pickup_enabled boolean NOT NULL DEFAULT false, pickup_instructions text NOT NULL DEFAULT '',
 preparation_minutes integer NOT NULL DEFAULT 30 CHECK(preparation_minutes BETWEEN 1 AND 1440),
 PRIMARY KEY(store_id,source_id)
);
ALTER TABLE cart_checkout.carts ADD COLUMN fulfillment_store_id uuid REFERENCES fulfillment.stores(id);
UPDATE cart_checkout.carts SET fulfillment_store_id=(SELECT id FROM fulfillment.stores WHERE is_default);
CREATE FUNCTION fulfillment.default_store() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM fulfillment.stores WHERE is_default $$;
ALTER TABLE cart_checkout.carts ALTER COLUMN fulfillment_store_id SET DEFAULT fulfillment.default_store();
ALTER TABLE cart_checkout.carts ALTER COLUMN fulfillment_store_id SET NOT NULL;
CREATE TABLE fulfillment.plans (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers.customers(id), cart_id uuid NOT NULL REFERENCES cart_checkout.carts(id),
 store_id uuid NOT NULL REFERENCES fulfillment.stores(id), method text NOT NULL CHECK(method IN ('delivery','pickup')),
 location_id uuid, fingerprint jsonb NOT NULL, capabilities jsonb NOT NULL, request jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('HELD','CONFIRMED','RELEASED','EXPIRED','CANCELLED')),
 expires_at timestamptz NOT NULL, order_id uuid REFERENCES orders.orders(id), idempotency_key uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(customer_id,idempotency_key)
);
CREATE UNIQUE INDEX fulfillment_one_plan ON fulfillment.plans(cart_id) WHERE status='HELD';
CREATE TABLE fulfillment.plan_groups (
 id uuid PRIMARY KEY, plan_id uuid NOT NULL REFERENCES fulfillment.plans(id), source_id uuid NOT NULL REFERENCES inventory.inventory_sources(id),
 method text NOT NULL CHECK(method IN ('delivery','pickup')), area_id uuid REFERENCES inventory.delivery_areas(id), schedule_id uuid REFERENCES fulfillment.schedules(id),
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK(ends_at>starts_at), timezone text NOT NULL,
 requirement jsonb NOT NULL, release_before text NOT NULL, UNIQUE(plan_id,source_id)
);
CREATE TABLE fulfillment.plan_items (
 group_id uuid REFERENCES fulfillment.plan_groups(id), product_id uuid NOT NULL REFERENCES catalog.products(id),
 stock_id uuid NOT NULL REFERENCES inventory.stocks(id), quantity integer NOT NULL CHECK(quantity>0), PRIMARY KEY(group_id,product_id)
);
ALTER TABLE fulfillment.capacity_reservations ADD COLUMN group_id uuid REFERENCES fulfillment.plan_groups(id);
ALTER TABLE fulfillment.capacity_reservations ALTER COLUMN schedule_id DROP NOT NULL;
DROP INDEX fulfillment.capacity_one_cart_hold;
CREATE UNIQUE INDEX capacity_one_legacy_hold ON fulfillment.capacity_reservations(cart_id) WHERE status='HELD' AND group_id IS NULL;
CREATE UNIQUE INDEX capacity_one_group_hold ON fulfillment.capacity_reservations(group_id) WHERE status IN ('HELD','CONFIRMED');
ALTER TABLE orders.orders DROP CONSTRAINT orders_status_check;
ALTER TABLE orders.orders ADD CHECK(status IN ('placed','confirmed','fulfilling','shipped','delivered','cash_collected','cancelled','delivery_failed','pickup_ready','picked_up'));
ALTER TABLE fulfillment.shipments ADD COLUMN method text NOT NULL DEFAULT 'delivery' CHECK(method IN ('delivery','pickup'));
ALTER TABLE fulfillment.shipments DROP CONSTRAINT shipment_status;
ALTER TABLE fulfillment.shipments ADD CHECK(status IN ('pending','shipped','delivered','delivery_failed','cancelled','pickup_ready','picked_up'));

ALTER TABLE fulfillment.shipments DROP CONSTRAINT shipment_tracking;
ALTER TABLE fulfillment.shipments ADD CONSTRAINT shipment_tracking CHECK((status IN ('pending','cancelled','pickup_ready','picked_up') AND tracking_reference='' AND dispatched_at IS NULL AND dispatched_by IS NULL) OR (status IN ('shipped','delivered','delivery_failed') AND length(tracking_reference) BETWEEN 1 AND 100 AND dispatched_at IS NOT NULL AND dispatched_by IS NOT NULL));
-- Low-level inventory reads this projection to avoid a circular domain dependency.
CREATE FUNCTION fulfillment.geofencing(store uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE((s.capabilities->>'geo_fencing_enabled')::boolean,(d.capabilities->>'geo_fencing_enabled')::boolean,true)
 FROM fulfillment.stores s CROSS JOIN fulfillment.system_capabilities d WHERE s.id=store
$$;
-- Before a receiving method is chosen, pickup-enabled stores may build a provisional
-- basket without a delivery pin. Checkout still requires an eligible, explicit plan.
CREATE FUNCTION fulfillment.cart_geofencing(cart uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT fulfillment.geofencing(c.fulfillment_store_id)
 AND COALESCE((s.capabilities->>'delivery_enabled')::boolean,(d.capabilities->>'delivery_enabled')::boolean,true)
 AND NOT (c.delivery_latitude IS NULL AND COALESCE((s.capabilities->>'pickup_enabled')::boolean,(d.capabilities->>'pickup_enabled')::boolean,false))
 FROM cart_checkout.carts c JOIN fulfillment.stores s ON s.id=c.fulfillment_store_id CROSS JOIN fulfillment.system_capabilities d WHERE c.id=cart
$$;
