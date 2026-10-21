-- Receipt is committed only after derived-store writes succeed. A crash before
-- commit can replay the write, so ClickHouse must retain its logical dedup key.
CREATE TABLE platform.consumer_receipts (
 consumer_name text NOT NULL,
 event_id uuid NOT NULL,
 processed_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (consumer_name, event_id)
);
