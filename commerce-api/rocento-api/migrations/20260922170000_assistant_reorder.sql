-- Keep the source order on the immutable result for audit and idempotent retry binding.
ALTER TABLE orders.orders ADD COLUMN reordered_from uuid REFERENCES orders.orders(id);
CREATE INDEX orders_reordered_from ON orders.orders(reordered_from) WHERE reordered_from IS NOT NULL;
