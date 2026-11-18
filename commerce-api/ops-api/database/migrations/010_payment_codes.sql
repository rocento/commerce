ALTER TABLE payment_requests ADD COLUMN service_months integer CHECK(service_months IN (1,12));
ALTER TABLE billing_entitlements ADD COLUMN service_months integer CHECK(service_months IN (1,12));
CREATE TABLE payment_codes (
 payment_request_id uuid PRIMARY KEY REFERENCES payment_requests(id),
 code_hash text NOT NULL,
 operator_id text NOT NULL,
 receipt_reference text NOT NULL UNIQUE,
 failed_attempts integer NOT NULL DEFAULT 0,
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 redeemed_at timestamptz
);
