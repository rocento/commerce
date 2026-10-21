-- Existing coordinates remain pins; neighborhood reference points are explicit.
ALTER TABLE customers.customer_locations
    ADD COLUMN location_method text NOT NULL DEFAULT 'pin'
        CHECK (location_method IN ('pin', 'neighborhood')),
    ADD COLUMN geography jsonb;
ALTER TABLE customers.customer_locations ADD CONSTRAINT location_method_geography
    CHECK ((location_method = 'pin' AND geography IS NULL)
        OR (location_method = 'neighborhood' AND geography IS NOT NULL AND jsonb_typeof(geography) = 'object'));
