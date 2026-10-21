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
, sales AS (SELECT i.product_id,sum(i.quantity) AS units FROM period_orders o JOIN orders.order_items i ON i.order_id=o.id WHERE o.status NOT IN ('cancelled','delivery_failed') GROUP BY i.product_id)
 SELECT ARRAY[s.id::text,s.name,s.available::text,coalesce(v.units,0)::text] AS cells FROM stock_facts s CROSS JOIN args a LEFT JOIN sales v ON v.product_id=s.id WHERE s.available>=a.stock_threshold AND coalesce(v.units,0)<=a.sales_threshold ORDER BY coalesce(v.units,0),s.available DESC,s.id LIMIT 21
