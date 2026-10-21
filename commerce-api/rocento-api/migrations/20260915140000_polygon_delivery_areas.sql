-- Existing circular areas keep their coverage until an administrator draws a boundary.
ALTER TABLE inventory.delivery_areas ADD COLUMN boundary jsonb;
ALTER TABLE inventory.delivery_areas ADD CONSTRAINT delivery_boundary_shape CHECK (
 boundary IS NULL OR (jsonb_typeof(boundary) = 'array' AND jsonb_array_length(boundary) BETWEEN 3 AND 100)
);
CREATE FUNCTION inventory.boundary_contains(boundary jsonb, lat double precision, lng double precision)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT ('(' || string_agg(format('(%s,%s)', p->>'longitude', p->>'latitude'), ',' ORDER BY ordinal) || ')')::polygon @> point(lng,lat)
 FROM jsonb_array_elements(boundary) WITH ORDINALITY AS vertices(p,ordinal)
$$;
CREATE OR REPLACE FUNCTION inventory.resolve_delivery_area(lat double precision, lng double precision)
RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT a.id FROM inventory.delivery_areas a
 WHERE lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180
 AND a.is_active
 AND EXISTS(SELECT 1 FROM inventory.area_stock_links l WHERE l.area_id=a.id)
 AND CASE WHEN a.boundary IS NOT NULL THEN inventory.boundary_contains(a.boundary,lat,lng)
 ELSE 6371.0088 * 2 * asin(sqrt(least(1.0,
   power(sin(radians(a.center_lat-lat)/2),2)
   + cos(radians(lat))*cos(radians(a.center_lat))
   * power(sin(radians(a.center_lng-lng)/2),2)
 ))) <= a.radius_km END
 ORDER BY a.priority, CASE WHEN a.boundary IS NULL THEN a.radius_km ELSE 0 END,a.id LIMIT 1
$$;
