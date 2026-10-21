-- Additive tenant-database market policy. Currency never implies FX.
CREATE TABLE cart_checkout.market_configuration (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 currency text NOT NULL DEFAULT 'USD' CHECK(currency IN ('USD','EGP')),
 region text NOT NULL DEFAULT 'US' CHECK(region IN ('US','EG')),
 industry text NOT NULL DEFAULT 'general' CHECK(industry IN ('general','grocery')),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0)
);
INSERT INTO cart_checkout.market_configuration DEFAULT VALUES;
CREATE TABLE cart_checkout.selling_rules (
 product_id uuid PRIMARY KEY REFERENCES catalog.products(id),
 rule jsonb NOT NULL CHECK(jsonb_typeof(rule)='object'),
 updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE orders.order_items ADD COLUMN market_facts jsonb;
COMMENT ON COLUMN orders.order_items.market_facts IS 'v1 immutable product/options/physical measure/currency facts. NULL denotes a legacy order with incomplete facts.';
-- Broaden existing checks without rewriting historical values.
ALTER TABLE catalog.products DROP CONSTRAINT products_currency_check;
ALTER TABLE catalog.products ADD CONSTRAINT products_currency_check CHECK(currency IN ('USD','EGP'));
ALTER TABLE fulfillment.delivery_fee_settings DROP CONSTRAINT delivery_fee_settings_currency_check;
ALTER TABLE fulfillment.delivery_fee_settings ADD CONSTRAINT delivery_fee_settings_currency_check CHECK(currency IN ('USD','EGP'));

ALTER TABLE cart_checkout.carts ADD COLUMN market_delivery_date text CHECK(market_delivery_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
