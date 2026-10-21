WITH args AS (SELECT $1::date AS start_date, $2::date AS end_date, $3::text AS currency,
 $4::date AS previous_date, $5::integer AS stock_threshold, $6::integer AS sales_threshold, $7::uuid AS order_id),
 period_orders AS (SELECT o.* FROM orders.orders o,args a WHERE o.currency=a.currency
 AND o.created_at >= (a.start_date::timestamp AT TIME ZONE 'UTC')
 AND o.created_at < ((a.end_date+1)::timestamp AT TIME ZONE 'UTC'))
, category_sales AS (SELECT c.id,c.name,
 coalesce(sum(i.line_total-i.discount_amount) FILTER (WHERE o.created_at<(a.start_date::timestamp AT TIME ZONE 'UTC')),0) AS previous,
 coalesce(sum(i.line_total-i.discount_amount) FILTER (WHERE o.created_at>=(a.start_date::timestamp AT TIME ZONE 'UTC')),0) AS current
 FROM orders.orders o JOIN orders.order_items i ON i.order_id=o.id JOIN catalog.products p ON p.id=i.product_id JOIN catalog.categories c ON c.id=p.category_id CROSS JOIN args a
 WHERE o.currency=a.currency AND o.status NOT IN ('cancelled','delivery_failed') AND o.created_at>=(a.previous_date::timestamp AT TIME ZONE 'UTC') AND o.created_at<((a.end_date+1)::timestamp AT TIME ZONE 'UTC') GROUP BY c.id,c.name)
 SELECT ARRAY[id::text,name,previous::text,current::text,(current-previous)::text] AS cells FROM category_sales WHERE current<previous ORDER BY current-previous,id LIMIT 21
