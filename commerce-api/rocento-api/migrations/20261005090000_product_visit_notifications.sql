-- A null trigger preserves existing broadcast visibility. Product campaigns only
-- become visible after a server-recorded grant for the current recipient.
ALTER TABLE platform.storefront_notification_publications
    ADD COLUMN trigger_product_id uuid REFERENCES catalog.products(id),
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
