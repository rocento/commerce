-- One audience definition for scheduled announcements and journey-driven campaigns.
ALTER TABLE platform.storefront_notification_publications
 ADD COLUMN audience_rules jsonb,
 ADD CONSTRAINT storefront_notification_rules_object CHECK (audience_rules IS NULL OR (jsonb_typeof(audience_rules)='object' AND source_record_id IS NULL));
ALTER TABLE platform.storefront_notification_deliveries
 ADD COLUMN delivery_count integer NOT NULL DEFAULT 1 CHECK(delivery_count BETWEEN 1 AND 100),
 ADD COLUMN last_event_id text;
CREATE TABLE platform.notification_campaigns (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK(char_length(name) BETWEEN 1 AND 200),
 description text NOT NULL CHECK(char_length(description)<=2000),
 announcement jsonb NOT NULL CHECK(jsonb_typeof(announcement)='object'),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 publication_id uuid UNIQUE REFERENCES platform.storefront_notification_publications(id),
 created_by uuid NOT NULL,
 updated_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX notification_campaigns_updated ON platform.notification_campaigns(updated_at DESC,id);
-- Guest activity remains tied only to its random inbox cookie. No identity stitching.
CREATE TABLE platform.notification_campaign_events (
 recipient_id uuid NOT NULL REFERENCES platform.storefront_notification_recipients(id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('visit','product_view')),
 reference text NOT NULL DEFAULT '',
 event_id uuid NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(recipient_id,kind,reference)
);
