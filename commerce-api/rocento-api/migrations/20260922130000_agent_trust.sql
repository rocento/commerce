ALTER TABLE cart_checkout.basket_proposals ADD COLUMN trust_fingerprint text;
CREATE TABLE cart_checkout.trust_configuration (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 tenant_id uuid, enabled boolean NOT NULL DEFAULT false,
 signed_http_enabled boolean NOT NULL DEFAULT false,
 denied_scopes text[] NOT NULL DEFAULT ARRAY['order.place','payment.authorize','order.refund'],
 policy_version text NOT NULL DEFAULT '1.0.0' CHECK(policy_version='1.0.0')
);
INSERT INTO cart_checkout.trust_configuration(singleton) VALUES(true);
CREATE TABLE cart_checkout.trust_agents (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 protocol text NOT NULL CHECK(protocol IN ('browser','signed_http')), enabled boolean NOT NULL DEFAULT false,
 public_key text, key_fingerprint text NOT NULL,
 allowed_scopes text[] NOT NULL, max_requests integer NOT NULL DEFAULT 30 CHECK(max_requests BETWEEN 1 AND 120),
 max_daily_actions integer NOT NULL DEFAULT 20 CHECK(max_daily_actions BETWEEN 1 AND 1000),
 max_daily_amount numeric(24,2) NOT NULL DEFAULT 1000 CHECK(max_daily_amount>=0), currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK((protocol='browser' AND public_key IS NULL) OR (protocol='signed_http' AND public_key IS NOT NULL AND length(public_key)<=8192))
);
CREATE TABLE cart_checkout.delegation_grants (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, agent_id uuid NOT NULL REFERENCES cart_checkout.trust_agents(id),
 customer_id uuid REFERENCES customers.customers(id), session_id uuid,
 cart_id uuid NOT NULL REFERENCES cart_checkout.carts(id), channel text NOT NULL CHECK(channel IN ('browser','signed_http')),
 nonce uuid NOT NULL, key_fingerprint text NOT NULL, allowed_scopes text[] NOT NULL, denied_scopes text[] NOT NULL,
 product_ids uuid[] NOT NULL DEFAULT '{}', category_ids uuid[] NOT NULL DEFAULT '{}', location_id uuid,
 max_amount numeric(24,2) NOT NULL CHECK(max_amount>=0), max_total numeric(24,2) NOT NULL CHECK(max_total>=max_amount),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), max_actions integer NOT NULL CHECK(max_actions BETWEEN 1 AND 100),
 used_actions integer NOT NULL DEFAULT 0, spent numeric(24,2) NOT NULL DEFAULT 0,
 confirmation_required boolean NOT NULL DEFAULT true CHECK(confirmation_required), policy_version text NOT NULL DEFAULT '1.0.0' CHECK(policy_version='1.0.0'),
 issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, revoked_at timestamptz,
 CHECK(expires_at>issued_at AND expires_at<=issued_at+interval '15 minutes'),
 CHECK((customer_id IS NULL AND session_id IS NULL AND channel='browser') OR (customer_id IS NOT NULL AND session_id IS NOT NULL))
);
CREATE INDEX delegation_grants_owner ON cart_checkout.delegation_grants(tenant_id,cart_id,issued_at DESC);
CREATE TABLE cart_checkout.agent_actions (
 id uuid PRIMARY KEY, grant_id uuid NOT NULL REFERENCES cart_checkout.delegation_grants(id),
 tenant_id uuid NOT NULL, agent_id uuid NOT NULL REFERENCES cart_checkout.trust_agents(id), cart_id uuid NOT NULL,
 proposal_id uuid NOT NULL REFERENCES cart_checkout.basket_proposals(id), idempotency_key uuid NOT NULL,
 action text NOT NULL CHECK(action='cart.apply'), risk text NOT NULL CHECK(risk='R2'),
 fingerprint text NOT NULL, expected_revision bigint NOT NULL,
 state text NOT NULL CHECK(state IN ('proposed','authorized','executing','committed','rejected','expired','failed','indeterminate','reconciled','compensated','closed')),
 amount numeric(24,2) NOT NULL, currency text NOT NULL,
 confirmed_at timestamptz NOT NULL, confirmation_session uuid,
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 failure_code text, UNIQUE(cart_id,idempotency_key), UNIQUE(proposal_id)
);
CREATE INDEX agent_actions_owner ON cart_checkout.agent_actions(tenant_id,cart_id,created_at DESC);
CREATE TABLE cart_checkout.agent_request_nonces (
 agent_id uuid NOT NULL REFERENCES cart_checkout.trust_agents(id), nonce uuid NOT NULL,
 expires_at timestamptz NOT NULL, PRIMARY KEY(agent_id,nonce)
);
