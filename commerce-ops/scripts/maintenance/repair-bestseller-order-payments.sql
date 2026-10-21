-- Repair only the explicitly marked synthetic bestseller fixture.
-- Run inside a transaction; inspect RETURNING rows before choosing COMMIT.
-- No payment collection, notifications, stock changes, or order status changes.
INSERT INTO payments.payment_transactions(order_id, method, amount_due, currency)
SELECT o.id, 'cod', o.total, o.currency
FROM orders.orders o
JOIN customers.customers c ON c.id = o.customer_id
WHERE c.id = md5('bestseller-demo:customer')::uuid
  AND c.email = 'bestseller-demo@example.test'
  AND o.contact->>'email' = 'bestseller-demo@example.test'
  AND o.contact->>'name' = 'Best-seller demo fixture'
  AND o.location->>'formatted_address' = 'Synthetic best-seller demo order'
  AND o.status = 'delivered'
  AND o.total >= 0
  AND EXISTS (
    SELECT 1 FROM orders.order_status_history h
    WHERE h.order_id = o.id
      AND h.reason = 'Synthetic best-seller demo fixture; not a real sale'
  )
ON CONFLICT (order_id) DO NOTHING
RETURNING order_id, method, amount_due, currency, collected_at;
