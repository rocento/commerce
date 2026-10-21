CREATE SCHEMA orders;
CREATE SCHEMA payments;
CREATE TABLE cart_checkout.quotes (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL, cart_id uuid NOT NULL,
 location_id uuid NOT NULL, snapshot jsonb NOT NULL,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quotes_customer ON cart_checkout.quotes(customer_id,created_at);
CREATE TABLE orders.orders (
 id uuid PRIMARY KEY, number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 customer_id uuid NOT NULL, quote_id uuid NOT NULL UNIQUE,
 idempotency_key uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('placed','confirmed','fulfilling','shipped','delivered','cash_collected','cancelled','delivery_failed')),
 location jsonb NOT NULL, contact jsonb NOT NULL,
 subtotal numeric(24,2) NOT NULL CHECK(subtotal>=0), delivery_fee numeric(24,2) NOT NULL CHECK(delivery_fee>=0),
 total numeric(24,2) NOT NULL CHECK(total=subtotal+delivery_fee), currency text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(customer_id,idempotency_key)
);
CREATE INDEX orders_customer ON orders.orders(customer_id,created_at DESC);
CREATE TABLE orders.order_items (
 order_id uuid NOT NULL REFERENCES orders.orders(id), product_id uuid NOT NULL,
 sku text NOT NULL, name text NOT NULL, unit text NOT NULL, quantity integer NOT NULL CHECK(quantity>0),
 price numeric(12,2) NOT NULL CHECK(price>=0), line_total numeric(24,2) NOT NULL CHECK(line_total=price*quantity),
 PRIMARY KEY(order_id,product_id)
);
CREATE TABLE orders.order_status_history (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders.orders(id),
 status text NOT NULL, actor_id uuid, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE payments.payment_transactions (
 order_id uuid PRIMARY KEY REFERENCES orders.orders(id), method text NOT NULL CHECK(method='cod'),
 amount_due numeric(24,2) NOT NULL CHECK(amount_due>=0), currency text NOT NULL,
 collected_at timestamptz, collected_by uuid,
 CHECK((collected_at IS NULL) = (collected_by IS NULL))
);
CREATE TABLE payments.manual_refunds (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES payments.payment_transactions(order_id),
 amount numeric(24,2) NOT NULL CHECK(amount>0), reason text NOT NULL, actor_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(order_id)
);
