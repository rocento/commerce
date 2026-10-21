-- Engagement uses the same publisher as commerce and needs the same retry fields.
-- IF NOT EXISTS also adopts the additive live repair without changing old checksums.
ALTER TABLE platform.outbox
    ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz,
    ADD COLUMN IF NOT EXISTS last_error text CHECK (last_error IN ('publish_unavailable', 'publish_timeout', 'invalid_subject', 'serialization_failed'));
CREATE INDEX IF NOT EXISTS outbox_available ON platform.outbox(available_at, created_at, id)
    WHERE published_at IS NULL;
