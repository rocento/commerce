WITH args AS (SELECT $1::date AS start_date, $2::date AS end_date, $3::text AS currency,
 $4::date AS previous_date, $5::integer AS stock_threshold, $6::integer AS sales_threshold, $7::uuid AS order_id),
 period_orders AS (SELECT o.* FROM orders.orders o,args a WHERE o.currency=a.currency
 AND o.created_at >= (a.start_date::timestamp AT TIME ZONE 'UTC')
 AND o.created_at < ((a.end_date+1)::timestamp AT TIME ZONE 'UTC'))
, stock_facts AS (SELECT p.id,p.name,p.sku,COALESCE(s.on_hand,0)::bigint AS on_hand,
 COALESCE(r.reserved,0)::bigint AS reserved,
 COALESCE(s.on_hand,0)::bigint-COALESCE(r.reserved,0)::bigint AS available
 FROM catalog.products p CROSS JOIN args a LEFT JOIN inventory.stock s ON s.product_id=p.id
 LEFT JOIN (SELECT product_id,sum(quantity) AS reserved FROM inventory.reservations WHERE expires_at>transaction_timestamp() GROUP BY product_id) r ON r.product_id=p.id
 WHERE p.active AND p.product_type='simple' AND p.currency=a.currency)
SELECT ARRAY[id::text,name,sku,on_hand::text,reserved::text,available::text] AS cells FROM stock_facts,args WHERE available<=stock_threshold ORDER BY available,id LIMIT 21
