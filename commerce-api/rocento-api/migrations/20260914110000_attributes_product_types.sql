-- Additive metadata: existing JSON values, product IDs and order statuses remain untouched.
CREATE SCHEMA attributes;
CREATE TABLE attributes.definitions (
 id uuid PRIMARY KEY, entity_type text NOT NULL CHECK(entity_type IN ('product','customer','category')),
 attribute_code text NOT NULL, label text NOT NULL, input_type text NOT NULL,
 scope text NOT NULL DEFAULT 'global' CHECK(scope='global'),
 is_required boolean NOT NULL DEFAULT false, is_unique boolean NOT NULL DEFAULT false,
 is_searchable boolean NOT NULL DEFAULT false, is_filterable boolean NOT NULL DEFAULT false,
 is_comparable boolean NOT NULL DEFAULT false, is_visible_on_front boolean NOT NULL DEFAULT false,
 used_for_promo_rules boolean NOT NULL DEFAULT false, used_for_configurations boolean NOT NULL DEFAULT false,
 swatch_type text NOT NULL DEFAULT 'none', options jsonb NOT NULL DEFAULT '[]', version integer NOT NULL DEFAULT 1,
 UNIQUE(entity_type,attribute_code)
);
ALTER TABLE catalog.products ADD COLUMN product_type text NOT NULL DEFAULT 'simple' CHECK(product_type IN ('simple','configurable','grouped','bundle'));
ALTER TABLE catalog.products ADD COLUMN parent_id uuid REFERENCES catalog.products(id);
ALTER TABLE catalog.products ADD COLUMN variant_attributes jsonb NOT NULL DEFAULT '{}';
CREATE INDEX product_parent ON catalog.products(parent_id);
CREATE TABLE catalog.product_configurations (
 id uuid PRIMARY KEY, parent_product_id uuid UNIQUE NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
 configurable_attributes text[] NOT NULL
);
CREATE TABLE catalog.product_links (
 parent_id uuid NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
 child_id uuid NOT NULL REFERENCES catalog.products(id), position integer NOT NULL,
 option_label text NOT NULL DEFAULT '', quantity integer NOT NULL DEFAULT 1 CHECK(quantity BETWEEN 1 AND 999),
 PRIMARY KEY(parent_id,child_id), CHECK(parent_id<>child_id)
);
ALTER TABLE catalog.categories ADD COLUMN attributes jsonb NOT NULL DEFAULT '{}';
ALTER TABLE customers.customers ADD COLUMN first_name text NOT NULL DEFAULT '';
ALTER TABLE customers.customers ADD COLUMN last_name text NOT NULL DEFAULT '';
ALTER TABLE customers.customers ADD COLUMN date_of_birth date;
ALTER TABLE customers.customers ADD COLUMN gender text NOT NULL DEFAULT '';
ALTER TABLE customers.customers ADD COLUMN customer_group text NOT NULL DEFAULT 'general';
ALTER TABLE customers.customers ADD COLUMN company_id uuid;
ALTER TABLE customers.customers ADD COLUMN negotiated_price_list_id uuid;
ALTER TABLE customers.customers ADD COLUMN attributes jsonb NOT NULL DEFAULT '{}';
ALTER TABLE orders.orders ADD COLUMN gift_message text;
CREATE TABLE orders.order_comments (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES orders.orders(id), admin_id uuid NOT NULL REFERENCES admin_iam.admin_users(id),
 body text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX order_comments_lookup ON orders.order_comments(order_id,created_at);
CREATE TABLE pricing_promotions.attribute_conditions (
 rule_id uuid PRIMARY KEY REFERENCES pricing_promotions.rules(id) ON DELETE CASCADE,
 conditions jsonb NOT NULL DEFAULT '{}'
);
