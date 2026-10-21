CREATE TABLE customers.memory_configuration (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 allowed_categories uuid[] NOT NULL DEFAULT '{}',
 view_weight integer NOT NULL DEFAULT 3 CHECK(view_weight BETWEEN 0 AND 20),
 purchase_weight integer NOT NULL DEFAULT 8 CHECK(purchase_weight BETWEEN 0 AND 20),
 return_weight integer NOT NULL DEFAULT -12 CHECK(return_weight BETWEEN -20 AND 0),
 half_life_days integer NOT NULL DEFAULT 14 CHECK(half_life_days BETWEEN 1 AND 90),
 retention_days integer NOT NULL DEFAULT 30 CHECK(retention_days BETWEEN 1 AND 90)
);
INSERT INTO customers.memory_configuration(singleton) VALUES(true);
CREATE TABLE customers.memory_subjects (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL,
 customer_id uuid REFERENCES customers.customers(id) ON DELETE CASCADE,
 guest_hash text UNIQUE,
 personalized boolean NOT NULL DEFAULT false,
 journey_consent boolean NOT NULL DEFAULT false,
 consent_version integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL,
 UNIQUE(tenant_id,customer_id),
 CHECK((customer_id IS NULL) <> (guest_hash IS NULL))
);
CREATE INDEX memory_subject_expiry ON customers.memory_subjects(expires_at);
CREATE TABLE customers.memory_contexts (
 subject_id uuid NOT NULL REFERENCES customers.memory_subjects(id) ON DELETE CASCADE,
 conversation_id uuid NOT NULL, revision bigint NOT NULL DEFAULT 1,
 snapshot jsonb NOT NULL CHECK(octet_length(snapshot::text)<=8192),
 expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(subject_id,conversation_id)
);
CREATE TABLE customers.preference_evidence (
 id uuid PRIMARY KEY, subject_id uuid NOT NULL REFERENCES customers.memory_subjects(id) ON DELETE CASCADE,
 attribute text NOT NULL CHECK(attribute IN ('product','brand','color','style','metal','material')),
 value text NOT NULL CHECK(length(value) BETWEEN 1 AND 100),
 category_id uuid NOT NULL REFERENCES catalog.categories(id) ON DELETE CASCADE,
 occasion text NOT NULL CHECK(occasion IN ('any','everyday','gift','work','travel')),
 recipient text NOT NULL CHECK(recipient IN ('self','other')),
 goal_id uuid,
 signal text NOT NULL CHECK(signal IN ('explicit_like','explicit_dislike')),
 weight integer NOT NULL CHECK(weight IN (-100,100)),
 provenance text NOT NULL DEFAULT 'customer_control',
 consent_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
);
CREATE INDEX memory_evidence_subject ON customers.preference_evidence(subject_id,expires_at);
CREATE TABLE customers.memory_consents (
 subject_id uuid NOT NULL REFERENCES customers.memory_subjects(id) ON DELETE CASCADE,
 version integer NOT NULL, personalized boolean NOT NULL, journey boolean NOT NULL,
 purpose text NOT NULL DEFAULT 'shopping_continuity_and_optional_recommendations_v1',
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(subject_id,version)
);
ALTER TABLE cart_checkout.goal_checkpoints ADD COLUMN display_name text NOT NULL DEFAULT '' CHECK(length(display_name)<=100);
ALTER TABLE cart_checkout.goal_checkpoints ADD COLUMN archived boolean NOT NULL DEFAULT false;
ALTER TABLE cart_checkout.goal_checkpoints ADD COLUMN metadata_revision bigint NOT NULL DEFAULT 1;
