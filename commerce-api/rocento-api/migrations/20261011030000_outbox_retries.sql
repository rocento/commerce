-- Additive: old publishers remain compatible, but do not honor retry scheduling.
ALTER TABLE platform.outbox
    ADD COLUMN attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    ADD COLUMN available_at timestamptz NOT NULL DEFAULT now(),
    ADD COLUMN last_attempt_at timestamptz,
    ADD COLUMN last_error text CHECK (last_error IN ('publish_unavailable', 'publish_timeout', 'invalid_subject', 'serialization_failed'));
CREATE INDEX outbox_available ON platform.outbox(available_at, created_at, id)
    WHERE published_at IS NULL;
