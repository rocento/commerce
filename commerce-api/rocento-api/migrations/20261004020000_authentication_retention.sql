-- Disposable authentication state is purged in bounded, concurrent-safe batches.
CREATE INDEX rate_limits_retention ON platform.rate_limits(window_start,key);
CREATE INDEX customer_sessions_retention ON customers.sessions(expires_at,id);
CREATE INDEX admin_sessions_retention ON admin_iam.sessions(expires_at,token_hash);
CREATE INDEX customer_challenges_retention ON customers.challenges(expires_at,customer_id,purpose);
