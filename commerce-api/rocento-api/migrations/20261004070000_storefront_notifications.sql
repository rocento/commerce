-- Native storefront inbox. No provider or external delivery worker consumes this data.
CREATE TABLE platform.storefront_notification_publications (
    id uuid PRIMARY KEY,
    source_record_id uuid UNIQUE REFERENCES platform.marketing_notification_records(id) ON DELETE CASCADE,
    customer_id uuid REFERENCES customers.customers(id) ON DELETE CASCADE,
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
    customer_id uuid UNIQUE REFERENCES customers.customers(id) ON DELETE CASCADE,
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
