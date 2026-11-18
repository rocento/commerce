-- Checkout and order detail read one order's history in chronological order.
-- Keep that lookup bounded as unrelated orders accumulate; retain every event.
CREATE INDEX order_status_history_order_created
 ON orders.order_status_history(order_id,created_at,id);
