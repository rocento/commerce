-- Durable invalidation is committed with domain writes; no external work in triggers.
CREATE TABLE platform.publication_freshness (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 generation bigint NOT NULL DEFAULT 1,
 scan_generation bigint NOT NULL DEFAULT 0,
 completed_generation bigint NOT NULL DEFAULT 0,
 cursor_kind text NOT NULL DEFAULT '', cursor_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
 next_scan_at timestamptz NOT NULL DEFAULT now(),
 next_batch_at timestamptz NOT NULL DEFAULT now(),
 next_delivery_at timestamptz NOT NULL DEFAULT now(),
 last_completed_at timestamptz, last_error text
);
INSERT INTO platform.publication_freshness(singleton) VALUES(true);
CREATE FUNCTION platform.publication_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE platform.publication_freshness SET generation=generation+1 WHERE singleton;
 RETURN NULL;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY[
 'catalog.products','catalog.categories','catalog.media','catalog.publication_images',
 'catalog.product_configurations','catalog.product_links','attributes.definitions','attributes.value_provenance',
 'cms.documents','cms.revisions','cms.releases','cms.discoverability_settings','cms.publication_metadata','cms.publication_entity',
 'pricing_promotions.rules','pricing_promotions.attribute_conditions','inventory.delivery_areas',
 'theme.assignments','theme.themes','theme.versions','platform.publication_routes'
 ] LOOP
 EXECUTE format('CREATE TRIGGER publication_changed AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION platform.publication_changed()',t);
 END LOOP;
END $$;
CREATE SEQUENCE platform.publication_version;
CREATE TABLE platform.publication_state (
 kind text NOT NULL, id uuid NOT NULL, path text NOT NULL,
 fingerprint text NOT NULL, version bigint NOT NULL,
 changed_at timestamptz NOT NULL, feed jsonb,
 PRIMARY KEY(kind,id)
);
CREATE TABLE platform.publication_feed_events (
 version bigint PRIMARY KEY DEFAULT nextval('platform.publication_version'),
 installation_id uuid NOT NULL, item_key text NOT NULL, product_id uuid NOT NULL,
 operation text NOT NULL CHECK(operation IN ('upsert','delete')),
 payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','retry','delivered','failed')),
 next_attempt_at timestamptz NOT NULL DEFAULT now(), error_code text
);
CREATE INDEX publication_feed_ready ON platform.publication_feed_events(next_attempt_at,version) WHERE status IN ('queued','retry');
CREATE INDEX publication_feed_history ON platform.publication_feed_events(item_key,version DESC);
CREATE TABLE platform.publication_reference_feed (
 item_key text PRIMARY KEY, version bigint NOT NULL, operation text NOT NULL, payload jsonb NOT NULL
);
-- lastmod is a content comparison timestamp, never catalog administrative updated_at.
CREATE OR REPLACE VIEW platform.publication_sitemap_resources AS
 SELECT 'products'::text AS kind,p.id,'/products/'||p.slug AS path,s.changed_at AS lastmod,p.slug AS route_key
 FROM catalog.products p LEFT JOIN catalog.products parent ON parent.id=p.parent_id
 LEFT JOIN platform.publication_state s ON s.kind='products' AND s.id=p.id AND s.path='/products/'||p.slug AND s.fingerprint<>'deleted'
 WHERE p.active AND (p.parent_id IS NULL OR parent.active)
 UNION ALL
 SELECT 'categories',c.id,'/categories/'||c.slug,s.changed_at,c.slug FROM catalog.categories c
 LEFT JOIN platform.publication_state s ON s.kind='categories' AND s.id=c.id AND s.path='/categories/'||c.slug AND s.fingerprint<>'deleted'
 UNION ALL
 SELECT 'content',d.id,'/pages/'||d.key,GREATEST(l.starts_at,s.changed_at),d.key
 FROM cms.documents d JOIN LATERAL (
 SELECT * FROM cms.releases WHERE document_id=d.id AND NOT cancelled
 AND starts_at<=transaction_timestamp() ORDER BY starts_at DESC,created_at DESC LIMIT 1
 ) l ON true JOIN cms.revisions r ON r.id=l.revision_id
 LEFT JOIN platform.publication_state s ON s.kind='content' AND s.id=d.id AND s.fingerprint<>'deleted'
 WHERE d.key<>'home' AND (l.ends_at IS NULL OR l.ends_at>transaction_timestamp());
