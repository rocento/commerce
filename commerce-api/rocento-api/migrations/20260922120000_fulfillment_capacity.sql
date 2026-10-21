-- Installation/database is the existing tenant boundary. All location references reuse MSI.
CREATE TABLE fulfillment.schedules (
 id uuid PRIMARY KEY,
 source_id uuid NOT NULL REFERENCES inventory.inventory_sources(id),
 area_id uuid REFERENCES inventory.delivery_areas(id),
 method text NOT NULL CHECK(length(method) BETWEEN 1 AND 60),
 enabled boolean NOT NULL DEFAULT false,
 timezone text NOT NULL,
 config jsonb NOT NULL CHECK(jsonb_typeof(config)='object'),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX fulfillment_schedule_scope ON fulfillment.schedules(source_id,method,COALESCE(area_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE TABLE fulfillment.capacity_rules (
 id uuid PRIMARY KEY,
 source_id uuid REFERENCES inventory.inventory_sources(id),
 area_id uuid REFERENCES inventory.delivery_areas(id),
 method text CHECK(length(method) BETWEEN 1 AND 60),
 timezone text NOT NULL DEFAULT 'UTC',
 local_start time,
 period text NOT NULL CHECK(period IN ('day','hour','slot')),
 limits jsonb NOT NULL CHECK(jsonb_typeof(limits)='object' AND limits<>'{}'::jsonb),
 overflow_percent integer NOT NULL DEFAULT 0 CHECK(overflow_percent BETWEEN 0 AND 100),
 starts_on date,
 ends_on date,
 enabled boolean NOT NULL DEFAULT true,
 CHECK(ends_on IS NULL OR starts_on IS NULL OR ends_on>=starts_on)
);
CREATE INDEX capacity_rule_lookup ON fulfillment.capacity_rules(source_id,area_id,method) WHERE enabled;
CREATE TABLE fulfillment.capacity_reservations (
 id uuid PRIMARY KEY,
 customer_id uuid NOT NULL REFERENCES customers.customers(id),
 cart_id uuid NOT NULL REFERENCES cart_checkout.carts(id),
 location_id uuid NOT NULL REFERENCES customers.customer_locations(id),
 schedule_id uuid NOT NULL REFERENCES fulfillment.schedules(id),
 source_id uuid NOT NULL REFERENCES inventory.inventory_sources(id),
 area_id uuid REFERENCES inventory.delivery_areas(id),
 method text NOT NULL,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL CHECK(ends_at>starts_at),
 fingerprint jsonb NOT NULL,
 requirement jsonb NOT NULL,
 status text NOT NULL CHECK(status IN ('HELD','CONFIRMED','RELEASED','EXPIRED','CANCELLED')),
 expires_at timestamptz NOT NULL,
 order_id uuid REFERENCES orders.orders(id),
 idempotency_key uuid NOT NULL,
 release_before text NOT NULL CHECK(release_before IN ('never','confirmed','fulfilling','shipped')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(customer_id,idempotency_key),
 CHECK((status IN ('CONFIRMED','CANCELLED'))=(order_id IS NOT NULL))
);
CREATE UNIQUE INDEX capacity_one_cart_hold ON fulfillment.capacity_reservations(cart_id) WHERE status='HELD';
CREATE INDEX capacity_expiration ON fulfillment.capacity_reservations(expires_at,id) WHERE status='HELD';
CREATE INDEX capacity_order ON fulfillment.capacity_reservations(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX capacity_slot ON fulfillment.capacity_reservations(source_id,starts_at,method);
-- A bucket row is also the lock identity. Ledger records avoid counter drift on retries/recovery.
CREATE TABLE fulfillment.capacity_buckets (
 rule_id uuid NOT NULL REFERENCES fulfillment.capacity_rules(id),
 bucket_key text NOT NULL,
 PRIMARY KEY(rule_id,bucket_key)
);
CREATE TABLE fulfillment.capacity_consumption (
 reservation_id uuid NOT NULL REFERENCES fulfillment.capacity_reservations(id),
 rule_id uuid NOT NULL,
 bucket_key text NOT NULL,
 PRIMARY KEY(reservation_id,rule_id,bucket_key),
 FOREIGN KEY(rule_id,bucket_key) REFERENCES fulfillment.capacity_buckets(rule_id,bucket_key)
);
CREATE INDEX capacity_consumption_lookup ON fulfillment.capacity_consumption(rule_id,bucket_key,reservation_id);
