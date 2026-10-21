CREATE TABLE attributes.sets (
 id uuid PRIMARY KEY,
 name text NOT NULL UNIQUE,
 description text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE attributes.set_members (
 set_id uuid NOT NULL REFERENCES attributes.sets(id) ON DELETE CASCADE,
 definition_id uuid NOT NULL REFERENCES attributes.definitions(id) ON DELETE RESTRICT,
 group_name text NOT NULL,
 position integer NOT NULL,
 PRIMARY KEY(set_id, definition_id),
 UNIQUE(set_id, group_name, position)
);

CREATE INDEX attribute_set_members_order
 ON attributes.set_members(set_id, group_name, position);

ALTER TABLE catalog.products
 ADD COLUMN attribute_set_id uuid REFERENCES attributes.sets(id) ON DELETE SET NULL;
CREATE INDEX product_attribute_set ON catalog.products(attribute_set_id);
