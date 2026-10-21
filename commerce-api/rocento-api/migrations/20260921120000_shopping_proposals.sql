-- Proposals never reserve stock. Revisions cover every cart writer, including merges/checkout.
ALTER TABLE cart_checkout.carts ADD COLUMN revision bigint NOT NULL DEFAULT 0;
CREATE FUNCTION cart_checkout.bump_item_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE cart_checkout.carts SET revision=revision+1 WHERE id=COALESCE(NEW.cart_id,OLD.cart_id);
 RETURN NULL;
END $$;
CREATE TRIGGER item_revision AFTER INSERT OR UPDATE OR DELETE ON cart_checkout.items
 FOR EACH ROW EXECUTE FUNCTION cart_checkout.bump_item_revision();
CREATE FUNCTION cart_checkout.bump_context_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.coupon_code,NEW.delivery_latitude,NEW.delivery_longitude) IS DISTINCT FROM
    (OLD.coupon_code,OLD.delivery_latitude,OLD.delivery_longitude) THEN
  NEW.revision := OLD.revision+1;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER context_revision BEFORE UPDATE ON cart_checkout.carts
 FOR EACH ROW EXECUTE FUNCTION cart_checkout.bump_context_revision();
CREATE TABLE cart_checkout.shopping_tasks (
 id uuid PRIMARY KEY, cart_id uuid NOT NULL REFERENCES cart_checkout.carts(id) ON DELETE CASCADE,
 revision bigint NOT NULL DEFAULT 0, draft jsonb NOT NULL,
 cancelled boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE cart_checkout.basket_proposals (
 id uuid PRIMARY KEY, cart_id uuid NOT NULL REFERENCES cart_checkout.carts(id) ON DELETE CASCADE,
 task_id uuid NOT NULL REFERENCES cart_checkout.shopping_tasks(id) ON DELETE CASCADE,
 task_revision bigint NOT NULL, source_revision bigint NOT NULL,
 input jsonb NOT NULL, quote jsonb NOT NULL, expires_at timestamptz NOT NULL,
 applied_key uuid, applied_cart jsonb, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(cart_id,applied_key)
);
CREATE INDEX shopping_tasks_cart ON cart_checkout.shopping_tasks(cart_id,updated_at DESC);
CREATE INDEX basket_proposals_task ON cart_checkout.basket_proposals(task_id,created_at DESC);
