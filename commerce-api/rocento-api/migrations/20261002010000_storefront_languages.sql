-- Translation preparation is isolated from public discovery and commerce data.
-- New languages remain draft until localized storefront publication is implemented.
CREATE TABLE cms.language_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
 source_locale text NOT NULL
);
INSERT INTO cms.language_settings(source_locale)
SELECT default_locale FROM cms.discoverability_settings WHERE singleton;

CREATE TABLE cms.storefront_languages (
 locale text PRIMARY KEY CHECK (length(locale) BETWEEN 2 AND 35),
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
 native_name text NOT NULL CHECK (length(btrim(native_name)) BETWEEN 1 AND 80),
 direction text NOT NULL CHECK (direction IN ('ltr','rtl')),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE cms.catalog_translations (
 locale text NOT NULL REFERENCES cms.storefront_languages(locale),
 entity_type text NOT NULL CHECK (entity_type IN ('product','category')),
 entity_id uuid NOT NULL,
 source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
 fields jsonb NOT NULL CHECK (jsonb_typeof(fields) = 'object'),
 reviewed boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 updated_by uuid NOT NULL REFERENCES admin_iam.admin_users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(locale,entity_type,entity_id)
);

CREATE VIEW cms.translation_sources AS
 SELECT 'product'::text AS entity_type, id AS entity_id, name,
 jsonb_build_object('name',name,'description',description) AS source
 FROM catalog.products
 UNION ALL
 SELECT 'category'::text, id, name, jsonb_build_object('name',name)
 FROM catalog.categories;
