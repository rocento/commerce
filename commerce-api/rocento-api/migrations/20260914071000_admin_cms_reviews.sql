CREATE SCHEMA cms;
CREATE TABLE cms.documents (
 id uuid PRIMARY KEY, key text UNIQUE NOT NULL, kind text NOT NULL CHECK(kind IN ('home','page','footer')),
 version integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='home' AND key='home') OR (kind='footer' AND key='footer') OR (kind='page' AND key NOT IN ('home','footer')))
);
CREATE TABLE cms.revisions (
 id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES cms.documents(id), version integer NOT NULL,
 title text NOT NULL, blocks jsonb NOT NULL, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(document_id,version)
);
CREATE TABLE cms.revision_media (
 revision_id uuid NOT NULL REFERENCES cms.revisions(id), media_id uuid NOT NULL REFERENCES catalog.media(id),
 PRIMARY KEY(revision_id,media_id)
);
CREATE TABLE cms.releases (
 id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES cms.documents(id), revision_id uuid REFERENCES cms.revisions(id),
 starts_at timestamptz NOT NULL, ends_at timestamptz, cancelled boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), CHECK(ends_at IS NULL OR ends_at>starts_at)
);
CREATE INDEX cms_release_lookup ON cms.releases(document_id,starts_at DESC,created_at DESC);
CREATE SCHEMA reviews;
CREATE TABLE reviews.reviews (
 id uuid PRIMARY KEY, product_id uuid NOT NULL, customer_id uuid NOT NULL REFERENCES customers.customers(id),
 display_name text NOT NULL, rating integer NOT NULL CHECK(rating BETWEEN 1 AND 5), title text NOT NULL, body text NOT NULL,
 status text NOT NULL CHECK(status IN ('pending','approved','rejected')), version integer NOT NULL DEFAULT 1,
 moderation_reason text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(product_id,customer_id)
);
CREATE INDEX reviews_queue ON reviews.reviews(status,updated_at DESC);
CREATE TABLE reviews.wishlist (
 customer_id uuid NOT NULL REFERENCES customers.customers(id), product_id uuid NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(customer_id,product_id)
);
CREATE TABLE admin_iam.saved_filters (
 id uuid PRIMARY KEY, admin_id uuid NOT NULL REFERENCES admin_iam.admin_users(id), name text NOT NULL,
 filters jsonb NOT NULL, UNIQUE(admin_id,name)
);
