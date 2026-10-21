SELECT i.product_id, SUM(i.quantity)::bigint AS units
FROM orders.order_items i
JOIN orders.orders o ON o.id = i.order_id
JOIN catalog.storefront_products p ON p.id = i.product_id
WHERE o.created_at >= $1 AND o.created_at < $2
  AND o.status IN ('delivered', 'cash_collected')
  AND o.location->>'area_id' = $3
  AND p.active
  AND (p.parent_id IS NULL OR EXISTS (
    SELECT 1 FROM catalog.storefront_products parent
    WHERE parent.id = p.parent_id AND parent.active
  ))
GROUP BY i.product_id
ORDER BY units DESC, i.product_id ASC
LIMIT 50
