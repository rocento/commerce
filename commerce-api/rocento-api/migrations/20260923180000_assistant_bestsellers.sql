-- Bound completed-sales aggregation by its requested calendar period.
CREATE INDEX orders_completed_sales_period ON orders.orders(created_at,id)
WHERE status IN ('delivered','cash_collected');
