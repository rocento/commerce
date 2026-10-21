-- Additive, per-installation opt-in. A checkpoint never grants commerce authority.
CREATE TABLE cart_checkout.execution_config (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 store_id uuid NOT NULL DEFAULT gen_random_uuid(),
 enabled boolean NOT NULL DEFAULT false
);
INSERT INTO cart_checkout.execution_config(singleton) VALUES(true);
CREATE TABLE cart_checkout.goal_checkpoints (
 task_id uuid PRIMARY KEY REFERENCES cart_checkout.shopping_tasks(id) ON DELETE CASCADE,
 cart_id uuid NOT NULL REFERENCES cart_checkout.carts(id) ON DELETE CASCADE,
 revision bigint NOT NULL CHECK (revision > 0),
 checkpoint jsonb NOT NULL CHECK (octet_length(checkpoint::text) <= 262144),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX goal_checkpoints_cart ON cart_checkout.goal_checkpoints(cart_id,updated_at DESC);
