-- Explicit market scope. NULL remains the existing store-wide market.
-- Named markets stay unavailable to checkout until activation is implemented.
ALTER TABLE cart_checkout.carts ADD COLUMN market_id uuid REFERENCES cart_checkout.market_drafts(id);
ALTER TABLE orders.orders ADD COLUMN market_context jsonb;
ALTER TABLE orders.orders ADD CONSTRAINT orders_market_context_object CHECK(market_context IS NULL OR jsonb_typeof(market_context)='object');
COMMENT ON COLUMN orders.orders.market_context IS 'Immutable checkout market identity, country, currency and configuration revision. NULL means historical order without recorded context.';
