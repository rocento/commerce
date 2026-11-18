ALTER TABLE onboarding_drafts DROP CONSTRAINT onboarding_drafts_payment_check;
UPDATE onboarding_drafts SET payment='ROCENTO';
ALTER TABLE onboarding_drafts ALTER COLUMN payment SET DEFAULT 'ROCENTO';
ALTER TABLE onboarding_drafts ADD CHECK(payment='ROCENTO');

CREATE TABLE payment_requests (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id),
 method text NOT NULL DEFAULT 'ROCENTO' CHECK(method='ROCENTO'),
 amount_minor bigint NOT NULL CHECK(amount_minor > 0 AND amount_minor <= 1000000000000),
 currency text NOT NULL CHECK(currency IN ('USD','EGP','SAR','AED','EUR','GBP')),
 service_days integer NOT NULL CHECK(service_days BETWEEN 1 AND 3660),
 instructions text NOT NULL CHECK(length(instructions) BETWEEN 1 AND 4000),
 status text NOT NULL DEFAULT 'AWAITING_PAYMENT' CHECK(status IN ('AWAITING_PAYMENT','CONFIRMED','EXPIRED')),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 confirmed_at timestamptz,
 confirmed_by text,
 receipt_reference text UNIQUE,
 CHECK ((status='CONFIRMED' AND confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL AND receipt_reference IS NOT NULL)
     OR (status<>'CONFIRMED' AND confirmed_at IS NULL AND confirmed_by IS NULL AND receipt_reference IS NULL))
);

-- Purchased service days are credited here. The future provisioning workflow
-- must establish the service start/end dates when it actually activates a store.
CREATE TABLE billing_entitlements (
 payment_request_id uuid PRIMARY KEY REFERENCES payment_requests(id),
 tenant_id uuid NOT NULL UNIQUE REFERENCES tenants(id),
 service_days integer NOT NULL CHECK(service_days BETWEEN 1 AND 3660),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE payment_confirmations (
 payment_request_id uuid PRIMARY KEY REFERENCES payment_requests(id),
 receipt_reference text NOT NULL UNIQUE,
 operator_id text NOT NULL,
 amount_minor bigint NOT NULL,
 currency text NOT NULL,
 service_days integer NOT NULL,
 confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER payment_confirmations_immutable BEFORE UPDATE OR DELETE ON payment_confirmations
 FOR EACH ROW EXECUTE FUNCTION immutable_audit();
