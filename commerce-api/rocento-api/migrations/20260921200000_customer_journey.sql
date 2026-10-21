-- Customer attribution comes from the verified access token, never the browser payload.
-- Anonymous analytics remain anonymous; historical sessions are not retroactively linked.
CREATE TABLE customers.journey_events (
 customer_id uuid NOT NULL REFERENCES customers.customers(id) ON DELETE CASCADE,
 id uuid NOT NULL,
 session_id uuid NOT NULL,
 event_type text NOT NULL CHECK (event_type IN ('page_view','search_query')),
 path text NOT NULL CHECK (length(path) <= 300),
 query text CHECK (length(query) <= 200),
 result_count bigint,
 source text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(customer_id,id)
);
CREATE INDEX journey_events_customer_time ON customers.journey_events(customer_id,occurred_at DESC,id DESC);
CREATE INDEX journey_outbox_cart ON platform.outbox((payload->>'cart_id'),created_at DESC)
 WHERE event_type IN ('cart.item_added','cart.item_removed','shopping.proposal_created','shopping.cart_applied');
