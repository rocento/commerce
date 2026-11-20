-- Each commerce database is one installation; no client-supplied tenant selector.
CREATE TABLE platform.google_connections (
 service text PRIMARY KEY CHECK(service IN ('merchant','ga4','maps')),
 revision bigint NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT false,
 config jsonb NOT NULL DEFAULT '{"account_id":"","data_source_id":"","language":"","feed_label":"","measurement_id":""}',
 credentials bytea,
 checked_at timestamptz,
 check_code text,
 sync_cursor uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
 next_sync_at timestamptz NOT NULL DEFAULT now(),
 last_sync_at timestamptz,
 sync_code text,
 sync_scanned bigint NOT NULL DEFAULT 0,
 sync_submitted bigint NOT NULL DEFAULT 0,
 sync_excluded bigint NOT NULL DEFAULT 0,
 sync_rejected bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO platform.google_connections(service) VALUES ('merchant'),('ga4'),('maps');
CREATE TABLE platform.google_products (
 product_id uuid PRIMARY KEY,
 submitted_at timestamptz NOT NULL DEFAULT now()
);
