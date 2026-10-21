ALTER TABLE platform.storefront_notification_publications ADD COLUMN area_ids uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE platform.storefront_notification_publications ADD CONSTRAINT notification_area_limit CHECK (cardinality(area_ids) <= 100 AND array_position(area_ids, NULL) IS NULL);
