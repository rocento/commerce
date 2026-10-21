-- Rules belong to the deployment's catalog (the same isolation boundary as products).
CREATE TABLE catalog.relationship_rules (
 id uuid PRIMARY KEY,
 definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX relationship_rules_priority ON catalog.relationship_rules (((definition->>'priority')::integer),id);
