CREATE SCHEMA theme;
CREATE TABLE theme.themes (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
 owner_channel text NOT NULL REFERENCES inventory.sales_channel_stock_links(channel_id),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 configuration jsonb NOT NULL CHECK (octet_length(configuration::text) <= 262144),
 published_version uuid,
 created_by uuid NOT NULL REFERENCES admin_iam.admin_users(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE theme.versions (
 id uuid PRIMARY KEY,
 theme_id uuid NOT NULL REFERENCES theme.themes(id),
 number integer NOT NULL CHECK (number > 0),
 configuration jsonb NOT NULL,
 created_by uuid NOT NULL REFERENCES admin_iam.admin_users(id),
 published_at timestamptz NOT NULL DEFAULT now(),
 source_version uuid,
 UNIQUE(theme_id, number), UNIQUE(theme_id, id),
 FOREIGN KEY(theme_id, source_version) REFERENCES theme.versions(theme_id, id)
);
ALTER TABLE theme.themes ADD FOREIGN KEY(id, published_version) REFERENCES theme.versions(theme_id, id);
CREATE TABLE theme.assignments (
 channel text PRIMARY KEY REFERENCES inventory.sales_channel_stock_links(channel_id),
 theme_id uuid REFERENCES theme.themes(id),
 revision integer NOT NULL DEFAULT 0 CHECK(revision >= 0),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX theme_assignments_theme ON theme.assignments(theme_id);
CREATE INDEX theme_owner ON theme.themes(owner_channel);
CREATE TABLE theme.draft_assets (
 theme_id uuid NOT NULL REFERENCES theme.themes(id),
 media_id uuid NOT NULL REFERENCES catalog.media(id),
 PRIMARY KEY(theme_id, media_id)
);
CREATE TABLE theme.version_assets (
 version_id uuid NOT NULL REFERENCES theme.versions(id),
 media_id uuid NOT NULL REFERENCES catalog.media(id),
 PRIMARY KEY(version_id, media_id)
);
CREATE FUNCTION theme.immutable_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published theme versions are immutable'; END;
$$;
CREATE TRIGGER immutable_theme_version BEFORE UPDATE OR DELETE ON theme.versions
FOR EACH ROW EXECUTE FUNCTION theme.immutable_version();
