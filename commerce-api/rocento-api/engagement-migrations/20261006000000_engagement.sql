-- Independent operational database: no checkout/order tables or customer secrets.
CREATE SCHEMA platform;
CREATE SCHEMA customers;
CREATE SCHEMA admin_iam;
CREATE SCHEMA catalog;
CREATE SCHEMA inventory;
CREATE TABLE platform.rate_limits(key text PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL);
CREATE TABLE platform.outbox(id uuid PRIMARY KEY,event_type text NOT NULL,payload jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),published_at timestamptz);
CREATE TABLE admin_iam.audit_log(id uuid PRIMARY KEY,actor_id uuid,action text NOT NULL,entity_id uuid NOT NULL,details jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE catalog.products(id uuid PRIMARY KEY,slug text NOT NULL,name text NOT NULL,active boolean NOT NULL);
CREATE INDEX engagement_product_slug ON catalog.products(slug);
CREATE TABLE inventory.delivery_areas(id uuid PRIMARY KEY,name text NOT NULL,center_lat double precision,center_lng double precision,radius_km double precision,priority integer,is_active boolean,boundary jsonb);
CREATE TABLE inventory.area_stock_links(area_id uuid NOT NULL,stock_id uuid NOT NULL,PRIMARY KEY(area_id,stock_id));
-- Customer attribution comes from the verified access token, never the browser payload.
-- Anonymous analytics remain anonymous; historical sessions are not retroactively linked.
CREATE TABLE customers.journey_events (
 customer_id uuid NOT NULL,
 id uuid NOT NULL,
 session_id uuid NOT NULL,
 event_type text NOT NULL CHECK (event_type IN ('page_view','search_query')),
 path text NOT NULL CHECK (length(path) <= 300),
 query text CHECK (length(query) <= 200),
 result_count bigint,
 source text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(customer_id,id)
);
CREATE INDEX journey_events_customer_time ON customers.journey_events(customer_id,occurred_at DESC,id DESC);
-- Provider-free marketing generation. These tables are never consumed by delivery workers.
CREATE TABLE platform.marketing_notification_programs (
    id uuid PRIMARY KEY,
    config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by uuid NOT NULL,
    updated_by uuid NOT NULL,
    CHECK (config->>'status' IN ('draft','active','paused','archived')),
    CHECK (config->>'channel' IN ('in_app','email','sms','whatsapp','push'))
);
CREATE INDEX marketing_notification_programs_updated ON platform.marketing_notification_programs(updated_at DESC,id);

CREATE TABLE platform.marketing_notification_records (
    id uuid PRIMARY KEY,
    program_id uuid NOT NULL REFERENCES platform.marketing_notification_programs(id),
    program_name text NOT NULL,
    program_version bigint NOT NULL CHECK (program_version > 0),
    customer_id uuid NOT NULL,
    event_id text NOT NULL CHECK (length(event_id) <= 100),
    channel text NOT NULL CHECK (channel IN ('in_app','email','sms','whatsapp','push')),
    title text NOT NULL CHECK (length(title) BETWEEN 1 AND 2000),
    body text NOT NULL CHECK (length(body) BETWEEN 1 AND 32000),
    status text NOT NULL DEFAULT 'generated' CHECK (status = 'generated'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by uuid NOT NULL,
    UNIQUE(program_id,customer_id,event_id)
);
CREATE INDEX marketing_notification_records_customer ON platform.marketing_notification_records(program_id,customer_id,created_at DESC);
CREATE INDEX marketing_notification_records_created ON platform.marketing_notification_records(created_at DESC,id);

-- Replaying a suppressed request cannot unexpectedly create content after eligibility changes.
CREATE TABLE platform.marketing_notification_requests (
    program_id uuid NOT NULL REFERENCES platform.marketing_notification_programs(id),
    idempotency_key uuid NOT NULL,
    customer_id uuid NOT NULL,
    program_version bigint NOT NULL CHECK (program_version > 0),
    outcome text NOT NULL CHECK (outcome IN ('generated','suppressed','duplicate')),
    reason text,
    record_id uuid REFERENCES platform.marketing_notification_records(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(program_id,idempotency_key)
);

CREATE INDEX marketing_notification_audit_entity ON admin_iam.audit_log(entity_id,created_at DESC,id)
    WHERE action LIKE 'notifications.%';

-- Native storefront inbox. No provider or external delivery worker consumes this data.
CREATE TABLE platform.storefront_notification_publications (
    id uuid PRIMARY KEY,
    source_record_id uuid UNIQUE REFERENCES platform.marketing_notification_records(id) ON DELETE CASCADE,
    customer_id uuid,
    audience text NOT NULL CHECK (audience IN ('all','guests','customers','customer')),
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 2000),
    body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 32000),
    cta_label text CHECK (char_length(cta_label) BETWEEN 1 AND 80),
    cta_path text CHECK (char_length(cta_path) BETWEEN 1 AND 300),
    published_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL CHECK (expires_at > published_at AND expires_at <= published_at + interval '2160 hours'),
    withdrawn_at timestamptz,
    withdrawn_by uuid,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    created_by uuid NOT NULL,
    request_hash text NOT NULL,
    CHECK ((cta_label IS NULL) = (cta_path IS NULL)),
    CHECK ((audience = 'customer') = (customer_id IS NOT NULL)),
    CHECK ((audience = 'customer') = (source_record_id IS NOT NULL)),
    CHECK ((withdrawn_at IS NULL) = (withdrawn_by IS NULL))
);
CREATE INDEX storefront_notification_active ON platform.storefront_notification_publications(published_at DESC,id DESC) WHERE withdrawn_at IS NULL;
CREATE INDEX storefront_notification_customer ON platform.storefront_notification_publications(customer_id,published_at DESC,id DESC) WHERE customer_id IS NOT NULL AND withdrawn_at IS NULL;

-- Content and targeting are immutable after publication. Withdrawal is the only edit.
CREATE FUNCTION platform.protect_storefront_notification_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW) - ARRAY['withdrawn_at','withdrawn_by','version']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['withdrawn_at','withdrawn_by','version'])
       OR OLD.withdrawn_at IS NOT NULL OR NEW.withdrawn_at IS NULL OR NEW.withdrawn_by IS NULL
       OR NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'Published storefront notification snapshots are immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER storefront_notification_snapshot_immutable BEFORE UPDATE ON platform.storefront_notification_publications
    FOR EACH ROW EXECUTE FUNCTION platform.protect_storefront_notification_snapshot();

CREATE TABLE platform.storefront_notification_publish_requests (
    actor_id uuid NOT NULL,
    idempotency_key uuid NOT NULL,
    request_hash text NOT NULL,
    publication_id uuid NOT NULL REFERENCES platform.storefront_notification_publications(id) ON DELETE CASCADE,
    PRIMARY KEY(actor_id,idempotency_key)
);

-- Raw guest bearer secrets are sent only as HttpOnly cookies, never persisted.
CREATE TABLE platform.storefront_notification_recipients (
    id uuid PRIMARY KEY,
    customer_id uuid UNIQUE,
    guest_hash text UNIQUE,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((customer_id IS NULL) <> (guest_hash IS NULL)),
    CHECK ((guest_hash IS NULL) = (expires_at IS NULL))
);
CREATE INDEX storefront_notification_guest_expiry ON platform.storefront_notification_recipients(expires_at) WHERE guest_hash IS NOT NULL;
CREATE TABLE platform.storefront_notification_read_states (
    recipient_id uuid NOT NULL REFERENCES platform.storefront_notification_recipients(id) ON DELETE CASCADE,
    publication_id uuid NOT NULL REFERENCES platform.storefront_notification_publications(id) ON DELETE CASCADE,
    read_at timestamptz,
    PRIMARY KEY(recipient_id,publication_id)
);

ALTER TABLE platform.storefront_notification_publications ADD COLUMN area_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE platform.storefront_notification_publications ADD CONSTRAINT notification_area_limit CHECK (cardinality(area_ids) <= 100 AND array_position(area_ids, NULL) IS NULL);

-- A null trigger preserves existing broadcast visibility. Product campaigns only
-- become visible after a server-recorded grant for the current recipient.
ALTER TABLE platform.storefront_notification_publications
    ADD COLUMN trigger_product_id uuid,
    ADD CONSTRAINT storefront_notification_product_audience
        CHECK (trigger_product_id IS NULL OR (source_record_id IS NULL AND audience IN ('all','guests','customers')));
CREATE INDEX storefront_notification_product_trigger
    ON platform.storefront_notification_publications(trigger_product_id)
    WHERE trigger_product_id IS NOT NULL AND withdrawn_at IS NULL;
CREATE TABLE platform.storefront_notification_deliveries (
    recipient_id uuid NOT NULL REFERENCES platform.storefront_notification_recipients(id) ON DELETE CASCADE,
    publication_id uuid NOT NULL REFERENCES platform.storefront_notification_publications(id) ON DELETE CASCADE,
    delivered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(recipient_id,publication_id)
);
CREATE INDEX storefront_notification_delivery_publication
    ON platform.storefront_notification_deliveries(publication_id);

CREATE FUNCTION inventory.boundary_contains(boundary jsonb, lat double precision, lng double precision)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT ('(' || string_agg(format('(%s,%s)', p->>'longitude', p->>'latitude'), ',' ORDER BY ordinal) || ')')::polygon @> point(lng,lat)
 FROM jsonb_array_elements(boundary) WITH ORDINALITY AS vertices(p,ordinal)
$$;
CREATE OR REPLACE FUNCTION inventory.resolve_delivery_area(lat double precision, lng double precision)
RETURNS uuid LANGUAGE sql STABLE AS $$
 SELECT a.id FROM inventory.delivery_areas a
 WHERE lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180
 AND a.is_active
 AND EXISTS(SELECT 1 FROM inventory.area_stock_links l WHERE l.area_id=a.id)
 AND CASE WHEN a.boundary IS NOT NULL THEN inventory.boundary_contains(a.boundary,lat,lng)
 ELSE 6371.0088 * 2 * asin(sqrt(least(1.0,
   power(sin(radians(a.center_lat-lat)/2),2)
   + cos(radians(lat))*cos(radians(a.center_lat))
   * power(sin(radians(a.center_lng-lng)/2),2)
 ))) <= a.radius_km END
 ORDER BY a.priority, CASE WHEN a.boundary IS NULL THEN a.radius_km ELSE 0 END,a.id LIMIT 1
$$;

CREATE TABLE platform.engagement_installation(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), source_id uuid NOT NULL, imported_at timestamptz NOT NULL DEFAULT clock_timestamp());
CREATE TABLE platform.engagement_jobs(
 id uuid PRIMARY KEY, dedupe_key text NOT NULL UNIQUE,
 kind text NOT NULL CHECK(kind IN ('browser','product_view')),
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 available_at timestamptz NOT NULL DEFAULT clock_timestamp(), attempts integer NOT NULL DEFAULT 0,
 completed_at timestamptz, failed_at timestamptz, last_error text);
CREATE INDEX engagement_jobs_pending ON platform.engagement_jobs(available_at,created_at) WHERE completed_at IS NULL AND failed_at IS NULL;
CREATE TABLE platform.engagement_worker_state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),heartbeat_at timestamptz NOT NULL,projection_at timestamptz);

ALTER TABLE platform.storefront_notification_publications ADD COLUMN deleted_at timestamptz;
ALTER TABLE platform.storefront_notification_publications ADD CONSTRAINT deleted_notifications_withdrawn CHECK (deleted_at IS NULL OR withdrawn_at IS NOT NULL);

-- Preserve immutable content while allowing withdrawal and terminal soft deletion.
CREATE OR REPLACE FUNCTION platform.protect_storefront_notification_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (to_jsonb(NEW) - ARRAY['withdrawn_at','withdrawn_by','deleted_at','version']) IS DISTINCT FROM
       (to_jsonb(OLD) - ARRAY['withdrawn_at','withdrawn_by','deleted_at','version'])
       OR OLD.deleted_at IS NOT NULL
       OR NEW.withdrawn_at IS NULL OR NEW.withdrawn_by IS NULL
       OR NEW.version <> OLD.version + 1
       OR (OLD.withdrawn_at IS NOT NULL AND
           (NEW.deleted_at IS NULL OR NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at
            OR NEW.withdrawn_by IS DISTINCT FROM OLD.withdrawn_by)) THEN
        RAISE EXCEPTION 'Published storefront notification snapshots are immutable';
    END IF;
    RETURN NEW;
END;
$$;
