-- Transactionally maintained read models: storefront never aggregates live source items.
CREATE TABLE inventory.source_availability (
 source_id uuid NOT NULL REFERENCES inventory.inventory_sources(id) ON DELETE CASCADE,
 product_id uuid NOT NULL REFERENCES inventory.stock(product_id),
 available bigint NOT NULL, PRIMARY KEY(source_id,product_id)
);
CREATE TABLE inventory.stock_availability (
 stock_id uuid NOT NULL REFERENCES inventory.stocks(id) ON DELETE CASCADE,
 product_id uuid NOT NULL REFERENCES inventory.stock(product_id),
 available bigint NOT NULL, PRIMARY KEY(stock_id,product_id)
);
CREATE FUNCTION inventory.refresh_availability(p uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM inventory.source_availability WHERE product_id=p;
 INSERT INTO inventory.source_availability
 SELECT i.source_id,i.product_id,greatest(0,i.quantity-COALESCE((
  SELECT SUM(a.quantity) FROM inventory.reservation_allocations a
  JOIN inventory.reservations r USING(cart_id,product_id)
  WHERE a.source_id=i.source_id AND a.product_id=p AND r.expires_at>clock_timestamp()
 ),0)) FROM inventory.source_items i
 JOIN inventory.inventory_sources s ON s.id=i.source_id AND s.is_enabled
 WHERE i.product_id=p AND i.status='in_stock';
 DELETE FROM inventory.stock_availability WHERE product_id=p;
 INSERT INTO inventory.stock_availability
 SELECT l.stock_id,p,SUM(a.available) FROM inventory.source_availability a
 JOIN inventory.source_stock_links l USING(source_id) WHERE a.product_id=p GROUP BY l.stock_id;
END;
$$;
SELECT inventory.refresh_availability(product_id) FROM inventory.stock;
ALTER TABLE cart_checkout.carts ADD COLUMN delivery_latitude double precision CHECK(delivery_latitude BETWEEN -90 AND 90);
ALTER TABLE cart_checkout.carts ADD COLUMN delivery_longitude double precision CHECK(delivery_longitude BETWEEN -180 AND 180);
ALTER TABLE cart_checkout.carts ADD CONSTRAINT cart_pin_pair CHECK((delivery_latitude IS NULL)=(delivery_longitude IS NULL));
