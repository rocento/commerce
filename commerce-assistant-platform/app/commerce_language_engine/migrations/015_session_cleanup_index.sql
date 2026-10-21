BEGIN;
CREATE INDEX pending_sessions_cancelled_idx ON context.sessions(cancelled_at) WHERE cancelled_at IS NOT NULL;
COMMIT;
