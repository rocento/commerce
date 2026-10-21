-- Null source means the location default; missing rules inherit the public fee.
CREATE TABLE fulfillment.delivery_fee_rules (
 id uuid PRIMARY KEY,
 area_id uuid REFERENCES inventory.delivery_areas(id) ON DELETE CASCADE,
 country_code text NOT NULL DEFAULT '',
 state_code text NOT NULL DEFAULT '',
 city_id text NOT NULL DEFAULT '',
 location_name text NOT NULL CHECK(length(trim(location_name)) BETWEEN 1 AND 300),
 source_id uuid REFERENCES inventory.inventory_sources(id) ON DELETE CASCADE,
 amount numeric(14,2) NOT NULL CHECK(amount BETWEEN 0 AND 1000000),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK ((area_id IS NOT NULL AND country_code='' AND state_code='' AND city_id='') OR
        (area_id IS NULL AND country_code ~ '^[A-Z]{2}$' AND length(state_code) BETWEEN 1 AND 200 AND length(city_id) BETWEEN 1 AND 200))
);
CREATE UNIQUE INDEX delivery_fee_rule_scope ON fulfillment.delivery_fee_rules
 (COALESCE(area_id,'00000000-0000-0000-0000-000000000000'::uuid),country_code,state_code,city_id,COALESCE(source_id,'00000000-0000-0000-0000-000000000000'::uuid));
