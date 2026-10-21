-- Explicit demo fixture, never run by migrations or normal deployment.
-- Uses existing visible products. No inventory changes, payment collection or notifications.
-- Order details require a COD obligation even for synthetic delivered orders.
BEGIN;
SELECT pg_advisory_xact_lock(20260928, 2);
SET LOCAL TIME ZONE 'UTC';
CREATE TEMP TABLE bestseller_demo ON COMMIT DROP AS
SELECT p.*, row_number() OVER (ORDER BY p.sku,p.id)::integer AS rank,
 date_trunc('month',now()) - interval '1 month' AS period_start
FROM (SELECT * FROM catalog.products WHERE active AND parent_id IS NULL
      ORDER BY sku,id LIMIT 8) p;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM bestseller_demo) THEN
   RAISE EXCEPTION 'No active products available; seed the demo catalog first';
 END IF;
END $$;
ALTER TABLE bestseller_demo ADD COLUMN demo_order_id uuid;
UPDATE bestseller_demo SET demo_order_id=md5('bestseller-demo:'||to_char(period_start,'YYYY-MM')||':'||id)::uuid;
INSERT INTO customers.customers(id,email,primary_identifier,password_hash,verified)
VALUES(md5('bestseller-demo:customer')::uuid,'bestseller-demo@example.test','email','!DEMO-NO-LOGIN',false)
ON CONFLICT DO NOTHING;
INSERT INTO orders.orders(id,customer_id,quote_id,idempotency_key,status,location,contact,
 subtotal,delivery_fee,total,currency,created_at,updated_at)
SELECT demo_order_id,md5('bestseller-demo:customer')::uuid,
 md5('bestseller-demo:quote:'||demo_order_id)::uuid,demo_order_id,'delivered',
 '{"formatted_address":"Synthetic best-seller demo order"}'::jsonb,
 '{"email":"bestseller-demo@example.test","name":"Best-seller demo fixture"}'::jsonb,
 price*(45-rank*5),0,price*(45-rank*5),currency,
 period_start+interval '14 days 12 hours',period_start+interval '16 days 12 hours'
FROM bestseller_demo ON CONFLICT DO NOTHING;
INSERT INTO payments.payment_transactions(order_id,method,amount_due,currency)
SELECT o.id,'cod',o.total,o.currency
FROM orders.orders o JOIN bestseller_demo d ON d.demo_order_id=o.id
ON CONFLICT (order_id) DO NOTHING;
INSERT INTO orders.order_items(order_id,product_id,sku,name,unit,quantity,price,line_total)
SELECT demo_order_id,id,sku,name,unit,45-rank*5,price,price*(45-rank*5)
FROM bestseller_demo ON CONFLICT DO NOTHING;
INSERT INTO orders.order_status_history(id,order_id,status,reason,created_at)
SELECT md5('bestseller-demo:history:'||demo_order_id)::uuid,demo_order_id,'delivered',
 'Synthetic best-seller demo fixture; not a real sale',period_start+interval '16 days 12 hours'
FROM bestseller_demo ON CONFLICT DO NOTHING;
SELECT json_build_object('period','last_month','timezone','UTC','start',min(d.period_start),
 'end',min(d.period_start)+interval '1 month',
 'products',json_agg(json_build_object('name',d.name,'sku',d.sku,'units',i.quantity) ORDER BY i.quantity DESC))
FROM bestseller_demo d JOIN orders.order_items i ON i.order_id=d.demo_order_id AND i.product_id=d.id;
COMMIT;
