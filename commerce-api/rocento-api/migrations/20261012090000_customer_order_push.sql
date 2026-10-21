-- Push tokens are private delivery addresses, never exposed in events or API reads.
CREATE TABLE platform.customer_push_devices (
 id uuid PRIMARY KEY,
 customer_id uuid NOT NULL REFERENCES customers.customers(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES customers.sessions(id) ON DELETE CASCADE,
 platform text NOT NULL CHECK (platform IN ('ios','android')),
 app_id text NOT NULL,
 token text NOT NULL CHECK (length(token) BETWEEN 32 AND 4096),
 locale text NOT NULL CHECK (locale IN ('en','ar')),
 enabled boolean NOT NULL DEFAULT true,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(platform,app_id,token)
);
CREATE INDEX customer_push_owner ON platform.customer_push_devices(customer_id) WHERE enabled;
CREATE TABLE platform.order_push_jobs (
 event_id uuid NOT NULL REFERENCES orders.order_status_history(id) ON DELETE CASCADE,
 device_id uuid NOT NULL REFERENCES platform.customer_push_devices(id) ON DELETE CASCADE,
 customer_id uuid NOT NULL REFERENCES customers.customers(id) ON DELETE CASCADE,
 order_id uuid NOT NULL REFERENCES orders.orders(id) ON DELETE CASCADE,
 state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','delivered','failed','expired')),
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 completed_at timestamptz,
 PRIMARY KEY(event_id,device_id)
);
CREATE INDEX order_push_ready ON platform.order_push_jobs(available_at) WHERE state='pending';
CREATE FUNCTION platform.enqueue_order_push() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status IN ('placed','confirmed','fulfilling','shipped','delivered','cancelled','pickup_ready','picked_up','delivery_failed') THEN
  INSERT INTO platform.order_push_jobs(event_id,device_id,customer_id,order_id)
  SELECT NEW.id,d.id,o.customer_id,o.id FROM orders.orders o
  JOIN platform.customer_push_devices d ON d.customer_id=o.customer_id
  JOIN customers.sessions s ON s.id=d.session_id AND s.customer_id=d.customer_id AND s.expires_at>clock_timestamp()
  WHERE o.id=NEW.order_id AND d.enabled AND d.updated_at>clock_timestamp()-interval '30 days'
  ON CONFLICT DO NOTHING;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_push_after_history AFTER INSERT ON orders.order_status_history
 FOR EACH ROW EXECUTE FUNCTION platform.enqueue_order_push();
