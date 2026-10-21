CREATE SCHEMA inventory;
CREATE SCHEMA cart_checkout;
CREATE TABLE inventory.stock (
 product_id uuid PRIMARY KEY, on_hand integer NOT NULL DEFAULT 0 CHECK(on_hand>=0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE inventory.reservations (
 cart_id uuid NOT NULL, product_id uuid NOT NULL REFERENCES inventory.stock(product_id),
 quantity integer NOT NULL CHECK(quantity>0), expires_at timestamptz NOT NULL,
 PRIMARY KEY(cart_id,product_id)
);
CREATE INDEX reservation_expiry ON inventory.reservations(expires_at);
CREATE TABLE inventory.adjustments (
 id uuid PRIMARY KEY, product_id uuid NOT NULL, actor_id uuid NOT NULL,
 before_quantity integer NOT NULL, after_quantity integer NOT NULL,
 reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cart_checkout.carts (
 id uuid PRIMARY KEY, customer_id uuid UNIQUE, guest_hash text UNIQUE,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK ((customer_id IS NULL) <> (guest_hash IS NULL))
);
CREATE TABLE cart_checkout.items (
 cart_id uuid REFERENCES cart_checkout.carts(id) ON DELETE CASCADE,
 product_id uuid NOT NULL, sku text NOT NULL, name text NOT NULL, unit text NOT NULL,
 price numeric(12,2) NOT NULL CHECK(price>=0), currency text NOT NULL DEFAULT 'USD',
 quantity integer NOT NULL CHECK(quantity>0 AND quantity<=1000000),
 PRIMARY KEY(cart_id,product_id)
);
