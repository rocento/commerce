-- Fetch the oldest unprocessed consent receipts without scanning retained history.
CREATE INDEX meta_checkout_consent_pending_created
ON platform.meta_checkout_consent(created_at)
WHERE processed_at IS NULL;
