CREATE TABLE customers.segments (
 id uuid PRIMARY KEY,
 definition jsonb NOT NULL CHECK (jsonb_typeof(definition)='object'),
 revision integer NOT NULL DEFAULT 1 CHECK(revision > 0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX customer_segments_updated ON customers.segments(updated_at DESC,id);
