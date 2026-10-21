CREATE TABLE customers.deletion_tombstones(customer_id uuid PRIMARY KEY);
CREATE FUNCTION customers.guard_deleted_owner() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner uuid;
BEGIN
 owner := (to_jsonb(NEW)->>'customer_id')::uuid;
 IF owner IS NULL THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(owner::text,71));
 IF EXISTS(SELECT 1 FROM customers.deletion_tombstones WHERE customer_id=owner) THEN RETURN NULL; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['customers.journey_events','platform.marketing_notification_records','platform.marketing_notification_requests','platform.storefront_notification_recipients','platform.storefront_notification_publications'] LOOP
  EXECUTE format('CREATE TRIGGER deleted_owner BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION customers.guard_deleted_owner()',target);
 END LOOP;
END $$;
