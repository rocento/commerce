CREATE SCHEMA catalog;
CREATE TABLE catalog.categories (
 id uuid PRIMARY KEY, name text NOT NULL, slug text NOT NULL UNIQUE,
 parent_id uuid REFERENCES catalog.categories(id), CHECK (parent_id IS DISTINCT FROM id)
);
CREATE TABLE catalog.attributes (
 id uuid PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('text','number','boolean')), required boolean NOT NULL DEFAULT false
);
CREATE TABLE catalog.media (
 id uuid PRIMARY KEY, content_type text NOT NULL, alt text NOT NULL,
 object_key text NOT NULL UNIQUE, size_bytes bigint NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE catalog.products (
 id uuid PRIMARY KEY, sku text NOT NULL UNIQUE, slug text NOT NULL UNIQUE,
 name text NOT NULL, description text NOT NULL, price numeric(12,2) NOT NULL CHECK (price >= 0),
 currency text NOT NULL CHECK (currency = 'USD'), unit text NOT NULL,
 category_id uuid NOT NULL REFERENCES catalog.categories(id), attributes jsonb NOT NULL DEFAULT '{}',
 media_ids uuid[] NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true,
 in_stock boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX products_category ON catalog.products(category_id);
