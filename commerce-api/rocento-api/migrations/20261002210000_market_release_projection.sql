-- Apply the cart market default after the immutable original release migration.
-- The storefront projection is already updated by migration 20261002190000.
CREATE FUNCTION cart_checkout.current_market_id() RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT r.market_id FROM cart_checkout.active_market a JOIN cart_checkout.market_releases r ON r.id=a.release_id
$$;
ALTER TABLE cart_checkout.carts ALTER COLUMN market_id SET DEFAULT cart_checkout.current_market_id();
