CREATE SCHEMA tax;
CREATE SCHEMA fulfillment;
CREATE TABLE tax.rules (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 min_lat double precision NOT NULL CHECK(min_lat BETWEEN -90 AND 90),
 max_lat double precision NOT NULL CHECK(max_lat BETWEEN -90 AND 90),
 min_lon double precision NOT NULL CHECK(min_lon BETWEEN -180 AND 180),
 max_lon double precision NOT NULL CHECK(max_lon BETWEEN -180 AND 180),
 rate_bps integer NOT NULL CHECK(rate_bps BETWEEN 0 AND 10000),
 tax_delivery boolean NOT NULL, priority integer NOT NULL UNIQUE CHECK(priority BETWEEN 0 AND 10000),
 active boolean NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK(min_lat<max_lat AND min_lon<max_lon)
);
CREATE TABLE fulfillment.delivery_fee_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id), amount numeric(12,2) NOT NULL CHECK(amount>=0),
 currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'), updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO fulfillment.delivery_fee_settings(id,amount) VALUES(true,3.00);
CREATE TABLE fulfillment.shipments (
 id uuid PRIMARY KEY, order_id uuid NOT NULL UNIQUE REFERENCES orders.orders(id),
 tracking_reference text NOT NULL UNIQUE CHECK(length(tracking_reference) BETWEEN 1 AND 100),
 status text NOT NULL CHECK(status IN ('shipped','delivered','delivery_failed')),
 dispatched_by uuid NOT NULL, dispatched_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE fulfillment.shipment_items (
 shipment_id uuid NOT NULL REFERENCES fulfillment.shipments(id), product_id uuid NOT NULL,
 quantity integer NOT NULL CHECK(quantity>0), PRIMARY KEY(shipment_id,product_id)
);
ALTER TABLE orders.orders ADD COLUMN tax_amount numeric(24,2) NOT NULL DEFAULT 0 CHECK(tax_amount>=0);
ALTER TABLE orders.orders ADD COLUMN tax_snapshot jsonb NOT NULL DEFAULT '{"rule_id":null,"name":"No tax applied","rate_bps":0,"tax_delivery":false,"taxable_base":"0.00","amount":"0.00"}';
-- M4's unnamed total CHECK received this deterministic PostgreSQL name.
ALTER TABLE orders.orders DROP CONSTRAINT orders_check;
ALTER TABLE orders.orders ADD CONSTRAINT order_total_components CHECK(total=subtotal+delivery_fee+tax_amount);
