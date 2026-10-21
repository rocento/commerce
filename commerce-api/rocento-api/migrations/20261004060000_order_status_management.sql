-- Configurable labels describe an existing workflow stage; they never replace it.
CREATE TABLE orders.status_definitions (
 code text PRIMARY KEY CHECK (code ~ '^[a-z][a-z0-9_]{1,47}$'),
 id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
 state text NOT NULL CHECK (state IN ('placed','confirmed','fulfilling','shipped','delivered','cash_collected','cancelled','delivery_failed','pickup_ready','picked_up')),
 label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
 translations jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(translations)='object'),
 description text NOT NULL DEFAULT '' CHECK (char_length(description)<=500),
 tone text NOT NULL DEFAULT 'neutral' CHECK (tone IN ('neutral','info','success','warning','danger')),
 customer_visible boolean NOT NULL DEFAULT true,
 is_default boolean NOT NULL DEFAULT false,
 is_system boolean NOT NULL DEFAULT false,
 active boolean NOT NULL DEFAULT true,
 revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (NOT is_default OR (active AND customer_visible)),
 CHECK (NOT is_system OR active)
);
CREATE UNIQUE INDEX one_default_order_status_per_state ON orders.status_definitions(state) WHERE is_default;
INSERT INTO orders.status_definitions(code,state,label,tone,is_default,is_system) VALUES
 ('pending','placed','Pending','info',true,true),
 ('confirmed','confirmed','Confirmed','info',true,true),
 ('processing','fulfilling','Processing','info',true,true),
 ('shipped','shipped','Shipped','info',true,true),
 ('delivered','delivered','Delivered','success',true,true),
 ('complete','cash_collected','Complete','success',true,true),
 ('canceled','cancelled','Canceled','neutral',true,true),
 ('delivery_failed','delivery_failed','Delivery failed','danger',true,true),
 ('ready_for_pickup','pickup_ready','Ready for pickup','info',true,true),
 ('picked_up','picked_up','Picked up','success',true,true);
UPDATE orders.status_definitions SET translations=jsonb_build_object('ar', CASE code
 WHEN 'pending' THEN 'قيد الانتظار' WHEN 'confirmed' THEN 'مؤكد'
 WHEN 'processing' THEN 'قيد التجهيز' WHEN 'shipped' THEN 'تم الشحن'
 WHEN 'delivered' THEN 'تم التسليم' WHEN 'complete' THEN 'مكتمل'
 WHEN 'canceled' THEN 'ملغي' WHEN 'delivery_failed' THEN 'تعذر التسليم'
 WHEN 'ready_for_pickup' THEN 'جاهز للاستلام' WHEN 'picked_up' THEN 'تم الاستلام' END);
ALTER TABLE orders.orders ADD COLUMN status_code text REFERENCES orders.status_definitions(code);
ALTER TABLE orders.orders ADD COLUMN status_revision bigint NOT NULL DEFAULT 1;
UPDATE orders.orders o SET status_code=d.code FROM orders.status_definitions d WHERE d.state=o.status AND d.is_default;
ALTER TABLE orders.orders ALTER COLUMN status_code SET NOT NULL;
CREATE INDEX order_status_code_index ON orders.orders(status_code);
CREATE FUNCTION orders.assign_workflow_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF NEW.status_code IS NULL THEN
   SELECT code INTO NEW.status_code FROM orders.status_definitions WHERE state=NEW.status AND is_default;
  END IF;
 ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
  SELECT code INTO NEW.status_code FROM orders.status_definitions WHERE state=NEW.status AND is_default;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM orders.status_definitions WHERE code=NEW.status_code AND state=NEW.status) THEN
  RAISE EXCEPTION 'Order status must belong to the current workflow stage';
 END IF;
 IF TG_OP='UPDATE' AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.status_code IS DISTINCT FROM OLD.status_code) THEN
  NEW.status_revision := OLD.status_revision+1;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER assign_workflow_status BEFORE INSERT OR UPDATE OF status,status_code ON orders.orders FOR EACH ROW EXECUTE FUNCTION orders.assign_workflow_status();
CREATE TABLE orders.status_label_history (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid NOT NULL REFERENCES orders.orders(id),
 actor_id uuid NOT NULL,
 state text NOT NULL,
 previous_code text NOT NULL,
 code text NOT NULL,
 previous_label text NOT NULL,
 label text NOT NULL,
 reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX order_status_label_history_order ON orders.status_label_history(order_id,created_at);
CREATE VIEW orders.orders_with_status AS
 SELECT o.*,
 jsonb_build_object('code',s.code,'label',s.label,'translations',s.translations,'tone',s.tone) AS status_display,
 jsonb_build_object('code',CASE WHEN s.customer_visible THEN s.code ELSE d.code END,
 'label',CASE WHEN s.customer_visible THEN s.label ELSE d.label END,
 'translations',CASE WHEN s.customer_visible THEN s.translations ELSE d.translations END,
 'tone',CASE WHEN s.customer_visible THEN s.tone ELSE d.tone END) AS customer_status_display
 FROM orders.orders o JOIN orders.status_definitions s ON s.code=o.status_code
 JOIN orders.status_definitions d ON d.state=o.status AND d.is_default;
