-- Anonymous discovery evidence, aligned with the existing 90-day browser analytics window.
CREATE TABLE platform.discovery_sessions (
 id uuid PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 first_touch jsonb NOT NULL, last_touch jsonb NOT NULL, ai_seen boolean NOT NULL
);
CREATE TABLE platform.discovery_events (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES platform.discovery_sessions(id) ON DELETE CASCADE,
 path text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX discovery_events_time ON platform.discovery_events(occurred_at,session_id);
CREATE TABLE platform.discovery_orders (
 order_id uuid PRIMARY KEY REFERENCES orders.orders(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES platform.discovery_sessions(id) ON DELETE CASCADE,
 first_touch jsonb NOT NULL, last_touch jsonb NOT NULL, ai_assisted boolean NOT NULL,
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX discovery_sessions_time ON platform.discovery_sessions(created_at);
