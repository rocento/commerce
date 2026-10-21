-- Additive MSI model. Existing stock, holds and order ownership stay intact.
CREATE TABLE inventory.inventory_sources (
 id uuid PRIMARY KEY, code text NOT NULL UNIQUE CHECK(length(code) BETWEEN 1 AND 64),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100), is_enabled boolean NOT NULL DEFAULT true,
 address text NOT NULL DEFAULT '', latitude double precision CHECK(latitude BETWEEN -90 AND 90),
 longitude double precision CHECK(longitude BETWEEN -180 AND 180),
 contact_name text NOT NULL DEFAULT '', contact_phone text NOT NULL DEFAULT '', priority integer NOT NULL DEFAULT 0,
 CHECK((latitude IS NULL) = (longitude IS NULL))
);
CREATE TABLE inventory.stocks (
 id uuid PRIMARY KEY, code text NOT NULL UNIQUE CHECK(length(code) BETWEEN 1 AND 64),
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100), is_default boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX one_default_stock ON inventory.stocks(is_default) WHERE is_default;
CREATE TABLE inventory.source_stock_links (
 stock_id uuid NOT NULL REFERENCES inventory.stocks(id) ON DELETE CASCADE,
 source_id uuid NOT NULL REFERENCES inventory.inventory_sources(id), priority integer NOT NULL DEFAULT 0,
 PRIMARY KEY(stock_id,source_id)
);
CREATE TABLE inventory.sales_channel_stock_links (
 channel_id text PRIMARY KEY, stock_id uuid NOT NULL REFERENCES inventory.stocks(id)
);
INSERT INTO inventory.inventory_sources(id,code,name) VALUES('00000000-0000-0000-0000-000000000001','default','Default warehouse');
INSERT INTO inventory.stocks(id,code,name,is_default) VALUES('00000000-0000-0000-0000-000000000001','default','Default stock',true);
INSERT INTO inventory.source_stock_links(stock_id,source_id) VALUES('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001');
INSERT INTO inventory.sales_channel_stock_links VALUES('storefront','00000000-0000-0000-0000-000000000001');
CREATE TABLE inventory.source_items (
 source_id uuid NOT NULL REFERENCES inventory.inventory_sources(id),
 product_id uuid NOT NULL REFERENCES inventory.stock(product_id),
 quantity integer NOT NULL CHECK(quantity BETWEEN 0 AND 1000000),
 status text NOT NULL DEFAULT 'in_stock' CHECK(status IN ('in_stock','out_of_stock')),
 notify_stock_qty integer NOT NULL DEFAULT 0 CHECK(notify_stock_qty BETWEEN 0 AND 1000000),
 PRIMARY KEY(source_id,product_id)
);
-- Product identity is stable across SKU edits and product deletion.
INSERT INTO inventory.source_items(source_id,product_id,quantity)
 SELECT '00000000-0000-0000-0000-000000000001',product_id,on_hand FROM inventory.stock;
CREATE TABLE inventory.reservation_allocations (
 cart_id uuid NOT NULL, product_id uuid NOT NULL, source_id uuid NOT NULL,
 stock_id uuid NOT NULL REFERENCES inventory.stocks(id), quantity integer NOT NULL CHECK(quantity>0),
 PRIMARY KEY(cart_id,product_id,source_id),
 FOREIGN KEY(cart_id,product_id) REFERENCES inventory.reservations(cart_id,product_id) ON DELETE CASCADE,
 FOREIGN KEY(source_id,product_id) REFERENCES inventory.source_items(source_id,product_id)
);
INSERT INTO inventory.reservation_allocations
 SELECT cart_id,product_id,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',quantity FROM inventory.reservations;
ALTER TABLE inventory.adjustments ADD COLUMN source_id uuid REFERENCES inventory.inventory_sources(id);
UPDATE inventory.adjustments SET source_id='00000000-0000-0000-0000-000000000001';
CREATE TABLE inventory.order_allocations (
 order_id uuid NOT NULL REFERENCES orders.orders(id), product_id uuid NOT NULL,
 source_id uuid NOT NULL REFERENCES inventory.inventory_sources(id), quantity integer NOT NULL CHECK(quantity>0),
 PRIMARY KEY(order_id,product_id,source_id)
);
INSERT INTO inventory.order_allocations
 SELECT order_id,product_id,'00000000-0000-0000-0000-000000000001',quantity FROM orders.order_items;
-- Keep existing readers of inventory.stock working: this is the default stock projection.
CREATE FUNCTION inventory.refresh_stock() RETURNS void LANGUAGE SQL AS $$
 UPDATE inventory.stock s SET on_hand=COALESCE((
  SELECT SUM(i.quantity)::integer FROM inventory.source_items i
  JOIN inventory.inventory_sources src ON src.id=i.source_id AND src.is_enabled
  JOIN inventory.source_stock_links l ON l.source_id=i.source_id
  JOIN inventory.stocks st ON st.id=l.stock_id AND st.is_default
  WHERE i.product_id=s.product_id AND i.status='in_stock'
 ),0),updated_at=clock_timestamp();
$$;

ALTER TABLE fulfillment.shipments DROP CONSTRAINT shipments_order_id_key;
ALTER TABLE fulfillment.shipments DROP CONSTRAINT shipments_tracking_reference_key;
ALTER TABLE fulfillment.shipments DROP CONSTRAINT shipments_tracking_reference_check;
ALTER TABLE fulfillment.shipments DROP CONSTRAINT shipments_status_check;
ALTER TABLE fulfillment.shipments ADD COLUMN source_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000001' REFERENCES inventory.inventory_sources(id);
ALTER TABLE fulfillment.shipments ALTER COLUMN dispatched_by DROP NOT NULL;
ALTER TABLE fulfillment.shipments ALTER COLUMN dispatched_at DROP NOT NULL;
ALTER TABLE fulfillment.shipments ALTER COLUMN dispatched_at DROP DEFAULT;
ALTER TABLE fulfillment.shipments ADD CONSTRAINT shipment_source_unique UNIQUE(order_id,source_id);
ALTER TABLE fulfillment.shipments ADD CONSTRAINT shipment_status CHECK(status IN ('pending','shipped','delivered','delivery_failed','cancelled'));
ALTER TABLE fulfillment.shipments ADD CONSTRAINT shipment_tracking CHECK((status IN ('pending','cancelled') AND tracking_reference='' AND dispatched_at IS NULL AND dispatched_by IS NULL) OR (status IN ('shipped','delivered','delivery_failed') AND length(tracking_reference) BETWEEN 1 AND 100 AND dispatched_at IS NOT NULL AND dispatched_by IS NOT NULL));
CREATE UNIQUE INDEX shipment_tracking_unique ON fulfillment.shipments(tracking_reference) WHERE tracking_reference<>'';
INSERT INTO fulfillment.shipments(id,order_id,source_id,tracking_reference,status)
 SELECT gen_random_uuid(),o.id,'00000000-0000-0000-0000-000000000001','','pending'
 FROM orders.orders o WHERE o.status IN ('placed','confirmed','fulfilling') AND NOT EXISTS(SELECT 1 FROM fulfillment.shipments s WHERE s.order_id=o.id);
INSERT INTO fulfillment.shipment_items(shipment_id,product_id,quantity)
 SELECT s.id,i.product_id,i.quantity FROM fulfillment.shipments s JOIN orders.order_items i ON i.order_id=s.order_id WHERE s.status='pending';
