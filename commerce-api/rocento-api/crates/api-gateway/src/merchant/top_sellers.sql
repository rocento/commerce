WITH args AS (SELECT $1::date AS start_date, $2::date AS end_date, $3::text AS currency,
 $4::date AS previous_date, $5::integer AS stock_threshold, $6::integer AS sales_threshold, $7::uuid AS order_id),
 period_orders AS (SELECT o.* FROM orders.orders o,args a WHERE o.currency=a.currency
 AND o.created_at >= (a.start_date::timestamp AT TIME ZONE 'UTC')
 AND o.created_at < ((a.end_date+1)::timestamp AT TIME ZONE 'UTC'))
, sales AS (SELECT i.product_id,(array_agg(i.name ORDER BY o.created_at DESC,o.id))[1] AS name,sum(i.quantity) AS units,sum(i.line_total-i.discount_amount) AS value FROM period_orders o JOIN orders.order_items i ON i.order_id=o.id WHERE o.status NOT IN ('cancelled','delivery_failed') GROUP BY i.product_id)
 SELECT ARRAY[product_id::text,name,units::text,value::text] AS cells FROM sales ORDER BY units DESC,product_id LIMIT 21
