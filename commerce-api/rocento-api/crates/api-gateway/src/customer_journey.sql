-- Every branch is scoped independently. Only allowlisted detail fields leave the database.
WITH activity AS (
 SELECT 'browser:' || e.id::text AS id, e.occurred_at,
   CASE WHEN e.event_type='search_query' THEN 'search'
     WHEN e.path='/' THEN 'visit'
     WHEN e.path LIKE '/products/%' THEN 'product_view'
     WHEN e.path LIKE '/categories/%' THEN 'category_view'
     ELSE 'page_view' END AS kind,
   'storefront'::text AS source, e.session_id,
   jsonb_strip_nulls(jsonb_build_object('path',e.path,'query',e.query,'result_count',e.result_count,
     'traffic_source',e.source,'product_id',p.id,'product_name',p.name,'category_name',c.name)) AS details
 FROM customers.journey_events e
 LEFT JOIN LATERAL (SELECT id,name FROM catalog.products
   WHERE e.path='/products/' || id::text OR e.path='/products/' || slug
   ORDER BY (e.path='/products/' || id::text) DESC LIMIT 1) p ON true
 LEFT JOIN LATERAL (SELECT name FROM catalog.categories
   WHERE e.path='/categories/' || id::text OR e.path='/categories/' || slug
   ORDER BY (e.path='/categories/' || id::text) DESC LIMIT 1) c ON true
 WHERE e.customer_id=$1 AND e.occurred_at >= $2 AND e.occurred_at < $3
 UNION ALL
 SELECT 'cart:' || e.id::text, e.created_at, e.event_type, 'commerce', NULL::uuid,
   jsonb_strip_nulls(jsonb_build_object('product_id',p.id,'product_name',p.name,'quantity',e.payload->'quantity',
     'proposal_id',b.id,'mode',b.input->>'mode'))
 FROM cart_checkout.carts c
 JOIN platform.outbox e ON e.payload->>'cart_id'=c.id::text
 LEFT JOIN catalog.products p ON p.id::text=e.payload->>'product_id'
 LEFT JOIN cart_checkout.basket_proposals b ON b.id::text=e.payload->>'proposal_id' AND b.cart_id=c.id
 WHERE c.customer_id=$1 AND e.created_at >= $2 AND e.created_at < $3
   AND e.event_type IN ('cart.item_added','cart.item_removed','shopping.proposal_created','shopping.cart_applied')
 UNION ALL
 SELECT 'quote:' || q.id::text, q.created_at, 'checkout', 'commerce', NULL::uuid,
   jsonb_strip_nulls(jsonb_build_object('amount',q.snapshot->>'total','currency',q.snapshot->>'currency',
     'item_count',jsonb_array_length(q.snapshot->'items'),'payment_method',q.snapshot->>'payment_method'))
 FROM cart_checkout.quotes q
 WHERE $6 AND q.customer_id=$1 AND q.created_at >= $2 AND q.created_at < $3
 UNION ALL
 SELECT 'order:' || o.id::text, o.created_at, 'purchase', 'commerce', NULL::uuid,
   jsonb_strip_nulls(jsonb_build_object('order_id',o.id,'order_number',o.number,'amount',o.total::text,
     'currency',o.currency,'payment_method',p.method,
     'item_count',(SELECT COALESCE(sum(quantity),0) FROM orders.order_items WHERE order_id=o.id)))
 FROM orders.orders o LEFT JOIN payments.payment_transactions p ON p.order_id=o.id
 WHERE $6 AND o.customer_id=$1 AND o.created_at >= $2 AND o.created_at < $3
 UNION ALL
 SELECT 'status:' || h.id::text, h.created_at, 'order_status', 'commerce', NULL::uuid,
   jsonb_build_object('order_id',o.id,'order_number',o.number,'status',h.status)
 FROM orders.order_status_history h JOIN orders.orders o ON o.id=h.order_id
 WHERE $6 AND o.customer_id=$1 AND h.status<>'placed' AND h.created_at >= $2 AND h.created_at < $3
)
SELECT * FROM activity
WHERE ($4::timestamptz IS NULL OR (occurred_at,id) < ($4::timestamptz,$5::text))
ORDER BY occurred_at DESC,id DESC LIMIT $7
