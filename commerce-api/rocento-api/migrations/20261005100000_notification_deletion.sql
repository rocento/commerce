ALTER TABLE platform.storefront_notification_publications ADD COLUMN deleted_at timestamptz;
ALTER TABLE platform.storefront_notification_publications ADD CONSTRAINT deleted_notifications_withdrawn CHECK (deleted_at IS NULL OR withdrawn_at IS NOT NULL);
