-- Keep 20260922120000 byte-identical to the version already applied on EC2.
-- Capacity additions belong in this forward-only migration.
CREATE TABLE fulfillment.capacity_settings (
 id boolean PRIMARY KEY DEFAULT true CHECK(id),
 enabled boolean NOT NULL DEFAULT false
);
INSERT INTO fulfillment.capacity_settings(id) VALUES(true);

ALTER TABLE fulfillment.capacity_rules
 ADD COLUMN overrides_rule_id uuid REFERENCES fulfillment.capacity_rules(id),
 ADD CONSTRAINT capacity_override_dates CHECK(
  overrides_rule_id IS NULL OR
  (overrides_rule_id<>id AND starts_on IS NOT NULL AND ends_on IS NOT NULL)
 );

-- Preserve the schedule timezone for existing holds and confirmed reservations.
ALTER TABLE fulfillment.capacity_reservations ADD COLUMN timezone text;
UPDATE fulfillment.capacity_reservations AS reservation
 SET timezone=schedule.timezone
 FROM fulfillment.schedules AS schedule
 WHERE schedule.id=reservation.schedule_id;
ALTER TABLE fulfillment.capacity_reservations ALTER COLUMN timezone SET NOT NULL;
-- Retain the historical location ID even when the customer deletes the address.
ALTER TABLE fulfillment.capacity_reservations
 DROP CONSTRAINT capacity_reservations_location_id_fkey;

CREATE INDEX capacity_override_lookup ON fulfillment.capacity_rules(overrides_rule_id,starts_on,ends_on) WHERE enabled;
CREATE INDEX capacity_active_time ON fulfillment.capacity_reservations(starts_at,ends_at,source_id) WHERE status IN ('HELD','CONFIRMED');
CREATE INDEX capacity_active_range ON fulfillment.capacity_reservations USING gist(tstzrange(starts_at,ends_at,'[)')) WHERE status IN ('HELD','CONFIRMED');
