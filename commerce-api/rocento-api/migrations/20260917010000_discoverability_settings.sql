CREATE TABLE cms.discoverability_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 enabled boolean NOT NULL DEFAULT false,
 indexing_enabled boolean NOT NULL DEFAULT false,
 llms_txt_enabled boolean NOT NULL DEFAULT true,
 site_name text NOT NULL DEFAULT 'Recento' CHECK (char_length(site_name) BETWEEN 1 AND 120),
 organization_name text NOT NULL DEFAULT 'Recento' CHECK (char_length(organization_name) BETWEEN 1 AND 120),
 canonical_url text,
 description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
 default_locale text NOT NULL DEFAULT 'en' CHECK (default_locale ~ '^[a-z]{2}(-[A-Z]{2})?$'),
 feature_pages_enabled boolean NOT NULL DEFAULT true,
 industry_pages_enabled boolean NOT NULL DEFAULT true,
 docs_enabled boolean NOT NULL DEFAULT true,
 pricing_page_enabled boolean NOT NULL DEFAULT false,
 security_page_enabled boolean NOT NULL DEFAULT true,
 integrations_page_enabled boolean NOT NULL DEFAULT true,
 changelog_enabled boolean NOT NULL DEFAULT true,
 grocery_demo_url text,
 jewelry_demo_url text,
 updated_by uuid REFERENCES admin_iam.admin_users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO cms.discoverability_settings(singleton) VALUES(true);
