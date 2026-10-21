CREATE TABLE customer_accounts (
 id uuid PRIMARY KEY, org_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
 email text NOT NULL UNIQUE CHECK(email=lower(email)), password_hash text NOT NULL,
 verified boolean NOT NULL DEFAULT false, disabled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE customer_sessions (
 token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES customer_accounts(id),
 expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_sessions_account ON customer_sessions(account_id);
CREATE TABLE account_challenges (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES customer_accounts(id),
 purpose text NOT NULL CHECK(purpose IN ('verify','reset')), token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL, UNIQUE(account_id,purpose)
);
CREATE TABLE auth_deliveries (
 id uuid PRIMARY KEY REFERENCES account_challenges(id) ON DELETE CASCADE,
 encrypted_payload text, attempts integer NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(), delivered_at timestamptz
);
CREATE TABLE auth_limits (key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL);
CREATE INDEX auth_limits_expiry ON auth_limits(expires_at);
CREATE TABLE onboarding_drafts (
 id uuid PRIMARY KEY, org_id uuid NOT NULL UNIQUE REFERENCES organizations(id),
 brand text NOT NULL DEFAULT '', slug text NOT NULL DEFAULT '',
 plan text NOT NULL DEFAULT 'LAUNCH' CHECK(plan IN ('LAUNCH','GROWTH','ENTERPRISE')),
 theme text REFERENCES storefront_themes(id),
 payment text NOT NULL DEFAULT 'PADDLE' CHECK(payment IN ('PADDLE','MANUAL_CASH')),
 version integer NOT NULL DEFAULT 0, tenant_id uuid UNIQUE REFERENCES tenants(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
