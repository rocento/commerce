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
    customer_id uuid NOT NULL REFERENCES customers.customers(id) ON DELETE CASCADE,
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
    customer_id uuid NOT NULL REFERENCES customers.customers(id) ON DELETE CASCADE,
    program_version bigint NOT NULL CHECK (program_version > 0),
    outcome text NOT NULL CHECK (outcome IN ('generated','suppressed','duplicate')),
    reason text,
    record_id uuid REFERENCES platform.marketing_notification_records(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(program_id,idempotency_key)
);

CREATE INDEX marketing_notification_audit_entity ON admin_iam.audit_log(entity_id,created_at DESC,id)
    WHERE action LIKE 'notifications.%';
