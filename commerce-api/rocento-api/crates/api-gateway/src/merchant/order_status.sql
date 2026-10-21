WITH args AS (SELECT $1::date AS start_date, $2::date AS end_date, $3::text AS currency,
 $4::date AS previous_date, $5::integer AS stock_threshold, $6::integer AS sales_threshold, $7::uuid AS order_id),
 period_orders AS (SELECT o.* FROM orders.orders o,args a WHERE o.currency=a.currency
 AND o.created_at >= (a.start_date::timestamp AT TIME ZONE 'UTC')
 AND o.created_at < ((a.end_date+1)::timestamp AT TIME ZONE 'UTC'))
SELECT ARRAY[o.id::text,o.number::text,o.status,to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'),o.total::text,coalesce(r.amount,0)::text] AS cells FROM period_orders o CROSS JOIN args a LEFT JOIN payments.manual_refunds r ON r.order_id=o.id WHERE o.id=a.order_id LIMIT 1
