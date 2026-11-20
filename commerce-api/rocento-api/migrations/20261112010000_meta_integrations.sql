-- Each merchant has its own database. Credentials are AEAD-encrypted by the application.
CREATE TABLE platform.meta_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 revision bigint NOT NULL DEFAULT 0,
 config jsonb NOT NULL DEFAULT '{}',
 credentials bytea,
 updated_at timestamptz NOT NULL DEFAULT now(),
 last_webhook_at timestamptz,
 last_feed_at timestamptz
);
INSERT INTO platform.meta_settings(singleton) VALUES(true);
CREATE TABLE platform.meta_checkout_consent (
 quote_id uuid PRIMARY KEY REFERENCES cart_checkout.quotes(id) ON DELETE CASCADE,
 customer_id uuid NOT NULL REFERENCES customers.customers(id) ON DELETE CASCADE,
 settings_revision bigint NOT NULL,
 conversions boolean NOT NULL,
 whatsapp boolean NOT NULL,
 phone_ciphertext bytea,
 created_at timestamptz NOT NULL DEFAULT now(),
 processed_at timestamptz
);
CREATE TABLE platform.meta_jobs (
 id uuid PRIMARY KEY,
 kind text NOT NULL CHECK(kind IN ('whatsapp','conversions')),
 dedupe_key text NOT NULL UNIQUE,
 settings_revision bigint NOT NULL,
 payload bytea NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','failed','unknown','cancelled')),
 attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 provider_id text,
 delivery_status text,
 error_code text
);
CREATE INDEX meta_jobs_pending ON platform.meta_jobs(available_at) WHERE status='pending';

-- Provider status receipts may arrive before the send response. No message body is retained.
CREATE TABLE platform.meta_delivery_receipts (
 provider_id text PRIMARY KEY,
 status text NOT NULL CHECK(status IN ('sent','delivered','read','failed')),
 received_at timestamptz NOT NULL DEFAULT now()
);
