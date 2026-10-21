CREATE SCHEMA pricing_promotions;
CREATE TABLE pricing_promotions.rules (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 scope text NOT NULL CHECK(scope IN ('catalog','cart')),
 kind text NOT NULL CHECK(kind IN ('percentage','fixed')),
 value numeric(12,2) NOT NULL CHECK(value>0 AND value<=1000000),
 coupon_code text UNIQUE CHECK(coupon_code ~ '^[A-Z0-9_-]{1,40}$'),
 min_subtotal numeric(24,2) NOT NULL CHECK(min_subtotal>=0),
 skus text[] NOT NULL, category_ids uuid[] NOT NULL,
 customer_group text NOT NULL CHECK(customer_group IN ('all','guest','registered','verified')),
 priority integer NOT NULL CHECK(priority BETWEEN 0 AND 10000),
 active boolean NOT NULL,
 starts_at timestamptz, ends_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(kind<>'percentage' OR value<=100),
 CHECK(scope='cart' OR coupon_code IS NULL),
 CHECK(starts_at IS NULL OR ends_at IS NULL OR starts_at<ends_at)
);
ALTER TABLE cart_checkout.carts ADD COLUMN coupon_code text;
ALTER TABLE orders.orders ADD COLUMN discount_amount numeric(24,2) NOT NULL DEFAULT 0 CHECK(discount_amount>=0 AND discount_amount<=subtotal);
ALTER TABLE orders.orders ADD COLUMN discount_snapshot jsonb NOT NULL DEFAULT '[]';
ALTER TABLE orders.orders ADD COLUMN coupon_code text;
ALTER TABLE orders.orders DROP CONSTRAINT order_total_components;
ALTER TABLE orders.orders ADD CONSTRAINT order_total_components CHECK(total=subtotal-discount_amount+delivery_fee+tax_amount);
ALTER TABLE orders.order_items ADD COLUMN discount_amount numeric(24,2) NOT NULL DEFAULT 0 CHECK(discount_amount>=0 AND discount_amount<=line_total);
ALTER TABLE orders.order_items ADD COLUMN discount_snapshot jsonb NOT NULL DEFAULT '[]';
-- Keep line_total as the original price × quantity; net lines subtract discount_amount.
