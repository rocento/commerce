-- Used only by m13-area-contract.py with its isolated minimal schema fixture.
BEGIN;
INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km,priority)
VALUES ('13000000-0000-0000-0000-000000000001','M13 Zone A',30,31,10,-100),
       ('13000000-0000-0000-0000-000000000002','M13 Zone B',31,31,10,-100),
       ('13000000-0000-0000-0000-000000000003','M13 Date line',0,179.99,10,-100);
DO $$ BEGIN
 ASSERT inventory.resolve_delivery_area(30,31) IS NULL, 'Unlinked area must not deliver';
END $$;
INSERT INTO inventory.area_stock_links(area_id,stock_id)
SELECT id,'00000000-0000-0000-0000-000000000001'::uuid FROM inventory.delivery_areas;
DO $$ BEGIN
 ASSERT inventory.resolve_delivery_area(30,31)='13000000-0000-0000-0000-000000000001'::uuid;
 ASSERT inventory.resolve_delivery_area(31,31)='13000000-0000-0000-0000-000000000002'::uuid;
 ASSERT inventory.resolve_delivery_area(0,-179.99)='13000000-0000-0000-0000-000000000003'::uuid;
 ASSERT inventory.resolve_delivery_area(-50,0) IS NULL, 'Outside must not fall back';
 ASSERT inventory.resolve_delivery_area('NaN',31) IS NULL;
 ASSERT inventory.resolve_delivery_area(91,31) IS NULL;
END $$;
INSERT INTO customers.customer_locations(id,latitude,longitude)
VALUES ('13000000-0000-0000-0000-000000000004',30,31);
DO $$ BEGIN
 ASSERT (SELECT area_id='13000000-0000-0000-0000-000000000001'::uuid FROM customers.customer_locations LIMIT 1);
END $$;
UPDATE customers.customer_locations SET latitude=31;
DO $$ BEGIN
 ASSERT (SELECT area_id='13000000-0000-0000-0000-000000000002'::uuid FROM customers.customer_locations LIMIT 1);
END $$;
UPDATE inventory.delivery_areas SET is_active=false WHERE name='M13 Zone B';
DO $$ BEGIN
 ASSERT (SELECT area_id IS NULL FROM customers.customer_locations LIMIT 1), 'Deactivation must refresh saved pins';
END $$;
UPDATE inventory.delivery_areas SET is_active=true WHERE name='M13 Zone B';
DELETE FROM inventory.area_stock_links WHERE area_id='13000000-0000-0000-0000-000000000002';
DO $$ BEGIN
 ASSERT (SELECT area_id IS NULL FROM customers.customer_locations LIMIT 1), 'Unlinking must refresh saved pins';
END $$;
INSERT INTO inventory.delivery_areas(id,name,center_lat,center_lng,radius_km,priority)
VALUES ('13000000-0000-0000-0000-000000000005','M13 Overlap',30,31,5,-101);
INSERT INTO inventory.area_stock_links VALUES
('13000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000001',0);
UPDATE customers.customer_locations SET latitude=30;
DO $$ BEGIN
 ASSERT (SELECT area_id='13000000-0000-0000-0000-000000000005'::uuid FROM customers.customer_locations LIMIT 1), 'Overlap priority must be deterministic';
END $$;
DELETE FROM inventory.delivery_areas WHERE name='M13 Overlap';
DO $$ BEGIN
 ASSERT (SELECT area_id='13000000-0000-0000-0000-000000000001'::uuid FROM customers.customer_locations LIMIT 1), 'Deleting overlap must resolve remaining zone';
END $$;
DELETE FROM inventory.delivery_areas WHERE name='M13 Zone A';
DO $$ BEGIN
 ASSERT (SELECT area_id IS NULL FROM customers.customer_locations LIMIT 1), 'Deleting last covering zone must clear area';
END $$;
ROLLBACK;
