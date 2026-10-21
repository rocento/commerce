-- M13 radius-based delivery zones. Lower priority values win overlapping zones.
CREATE TABLE inventory.delivery_areas (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
 center_lat double precision NOT NULL CHECK(center_lat BETWEEN -90 AND 90),
 center_lng double precision NOT NULL CHECK(center_lng BETWEEN -180 AND 180),
 radius_km double precision NOT NULL CHECK(radius_km > 0 AND radius_km <= 2000),
 priority integer NOT NULL DEFAULT 0,
 is_active boolean NOT NULL DEFAULT true
);
CREATE TABLE inventory.area_stock_links (
 area_id uuid NOT NULL REFERENCES inventory.delivery_areas(id) ON DELETE CASCADE,
 stock_id uuid NOT NULL REFERENCES inventory.stocks(id) ON DELETE CASCADE,
 priority integer NOT NULL DEFAULT 0,
 PRIMARY KEY(area_id,stock_id)
);
CREATE INDEX area_stock_links_stock ON inventory.area_stock_links(stock_id);

-- Haversine handles the date line and poles without a PostGIS dependency.
-- A zone without a stock is not deliverable. Never fall back to default stock.
CREATE FUNCTION inventory.resolve_delivery_area(lat double precision, lng double precision)
RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT a.id FROM inventory.delivery_areas a
 WHERE lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180
 AND a.is_active
 AND EXISTS(SELECT 1 FROM inventory.area_stock_links l WHERE l.area_id=a.id)
 AND 6371.0088 * 2 * asin(sqrt(least(1.0,
   power(sin(radians(a.center_lat-lat)/2),2)
   + cos(radians(lat))*cos(radians(a.center_lat))
   * power(sin(radians(a.center_lng-lng)/2),2)
 ))) <= a.radius_km
 ORDER BY a.priority,a.radius_km,a.id LIMIT 1
$$;

CREATE FUNCTION customers.resolve_location_area() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.area_id := inventory.resolve_delivery_area(NEW.latitude,NEW.longitude);
 RETURN NEW;
END;
$$;
CREATE TRIGGER resolve_location_area
 BEFORE INSERT OR UPDATE OF latitude,longitude,area_id ON customers.customer_locations
 FOR EACH ROW EXECUTE FUNCTION customers.resolve_location_area();

-- Saved pins must also reflect later zone edits, activation and stock unlinking.
CREATE FUNCTION inventory.refresh_location_areas() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE customers.customer_locations l
 SET area_id=inventory.resolve_delivery_area(l.latitude,l.longitude)
 WHERE l.area_id IS DISTINCT FROM inventory.resolve_delivery_area(l.latitude,l.longitude);
 RETURN NULL;
END;
$$;
CREATE TRIGGER refresh_location_areas
 AFTER INSERT OR UPDATE OR DELETE ON inventory.delivery_areas
 FOR EACH STATEMENT EXECUTE FUNCTION inventory.refresh_location_areas();
CREATE TRIGGER refresh_location_area_links
 AFTER INSERT OR UPDATE OR DELETE ON inventory.area_stock_links
 FOR EACH STATEMENT EXECUTE FUNCTION inventory.refresh_location_areas();

UPDATE customers.customer_locations SET area_id=NULL;
ALTER TABLE customers.customer_locations ADD CONSTRAINT customer_location_area_fk
 FOREIGN KEY(area_id) REFERENCES inventory.delivery_areas(id) ON DELETE SET NULL;
