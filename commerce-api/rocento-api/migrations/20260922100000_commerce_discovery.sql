CREATE TABLE catalog.discovery_configuration (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 semantic_enabled boolean NOT NULL DEFAULT false CHECK(NOT semantic_enabled),
 version integer NOT NULL DEFAULT 1 CHECK(version=1)
);
INSERT INTO catalog.discovery_configuration(singleton) VALUES(true);
CREATE TABLE catalog.discovery_edges (
 id uuid PRIMARY KEY,
 product_id uuid NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
 relation text NOT NULL CHECK(relation IN ('belongs_to','variant_of','compatible_with','incompatible_with','substitutes','complements','required_accessory','used_for','occasion','contains','excludes','selling_unit','policy_restriction','synonym')),
 target_product_id uuid REFERENCES catalog.products(id) ON DELETE CASCADE,
 value text NOT NULL CHECK(length(value) BETWEEN 1 AND 160),
 dimensions jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(dimensions)='object'),
 source text NOT NULL CHECK(source IN ('merchant','imported','generated')),
 reviewed boolean NOT NULL DEFAULT false,
 reviewed_by uuid,
 updated_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 CHECK(product_id IS DISTINCT FROM target_product_id),
 CHECK(NOT reviewed OR reviewed_by IS NOT NULL)
);
CREATE INDEX discovery_edges_product ON catalog.discovery_edges(product_id,expires_at);
CREATE INDEX discovery_edges_value ON catalog.discovery_edges(lower(value)) WHERE reviewed;
CREATE TABLE catalog.discovery_merchandising (
 product_id uuid PRIMARY KEY REFERENCES catalog.products(id) ON DELETE CASCADE,
 boost integer NOT NULL CHECK(boost BETWEEN 0 AND 10),
 sponsored boolean NOT NULL DEFAULT false,
 expires_at timestamptz NOT NULL,
 updated_by uuid NOT NULL
);
