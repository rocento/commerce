CREATE SCHEMA customers;
CREATE SCHEMA admin_iam;
CREATE SCHEMA platform;

CREATE TABLE platform.outbox (
 id uuid PRIMARY KEY, event_type text NOT NULL, payload jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz
);
CREATE INDEX outbox_pending ON platform.outbox(created_at) WHERE published_at IS NULL;
CREATE TABLE platform.rate_limits (
 key text PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL
);
CREATE TABLE customers.customers (
 id uuid PRIMARY KEY, email text, mobile_number text, primary_identifier text NOT NULL CHECK(primary_identifier IN ('email','mobile')),
 password_hash text NOT NULL, verified boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(email IS NOT NULL OR mobile_number IS NOT NULL),
 CHECK((primary_identifier='email' AND email IS NOT NULL) OR (primary_identifier='mobile' AND mobile_number IS NOT NULL))
);
CREATE UNIQUE INDEX customers_email ON customers.customers(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX customers_mobile ON customers.customers(mobile_number) WHERE mobile_number IS NOT NULL;
CREATE TABLE customers.sessions (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers.customers(id) ON DELETE CASCADE,
 refresh_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE customers.challenges (
 customer_id uuid NOT NULL REFERENCES customers.customers(id) ON DELETE CASCADE,
 purpose text NOT NULL CHECK(purpose IN ('verify','reset')),
 token_hash text NOT NULL, expires_at timestamptz NOT NULL,
 PRIMARY KEY(customer_id,purpose)
);
CREATE TABLE customers.customer_locations (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES customers.customers(id) ON DELETE CASCADE,
 label text NOT NULL CHECK(label IN ('home','work','other')), custom_label text NOT NULL DEFAULT '',
 latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),
 longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),
 formatted_address text NOT NULL, building text NOT NULL DEFAULT '', floor text NOT NULL DEFAULT '', apartment text NOT NULL DEFAULT '',
 delivery_instructions text NOT NULL DEFAULT '', area_id uuid,
 is_default boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX customer_locations_owner ON customers.customer_locations(customer_id);
CREATE UNIQUE INDEX customer_locations_default ON customers.customer_locations(customer_id) WHERE is_default;
CREATE TABLE admin_iam.roles (
 id uuid PRIMARY KEY, name text NOT NULL UNIQUE,
 permissions text[] NOT NULL, system boolean NOT NULL DEFAULT false
);
CREATE TABLE admin_iam.admin_users (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
 password_hash text NOT NULL, role_id uuid NOT NULL REFERENCES admin_iam.roles(id),
 active boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE admin_iam.sessions (
 token_hash text PRIMARY KEY, admin_id uuid NOT NULL REFERENCES admin_iam.admin_users(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL
);
CREATE TABLE admin_iam.audit_log (
 id uuid PRIMARY KEY, actor_id uuid REFERENCES admin_iam.admin_users(id), action text NOT NULL,
 entity_id uuid NOT NULL, details jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO admin_iam.roles(id,name,permissions,system) VALUES
 ('00000000-0000-0000-0000-000000000001','Super administrator',ARRAY['*'],true),
 ('00000000-0000-0000-0000-000000000002','Auditor',ARRAY['iam.users.read','iam.roles.read','iam.audit.read'],true);
