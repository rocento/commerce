-- Translation changes are durable index work, including review withdrawal and deletion.
CREATE INDEX catalog_translations_search_copy
 ON cms.catalog_translations(entity_type,entity_id,locale) WHERE reviewed;

-- The upgraded worker advances this only after a complete successful rebuild.
-- An older worker cannot accidentally acknowledge away the initial backfill.
CREATE TABLE catalog.search_index_schema (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 version integer NOT NULL CHECK(version > 0)
);
INSERT INTO catalog.search_index_schema(version) VALUES(1);

CREATE FUNCTION cms.notify_search_translation() RETURNS trigger
 LANGUAGE plpgsql AS $$
DECLARE
 kind text;
 entity uuid;
BEGIN
 IF TG_OP = 'DELETE' THEN
   kind := OLD.entity_type; entity := OLD.entity_id;
 ELSE
   kind := NEW.entity_type; entity := NEW.entity_id;
 END IF;
 IF kind = 'product' THEN
   INSERT INTO platform.outbox(id,event_type,payload)
   VALUES(gen_random_uuid(),'catalog.product_translation_updated',jsonb_build_object('id',entity));
 ELSIF kind = 'attribute' AND EXISTS(SELECT 1 FROM attributes.definitions WHERE id=entity AND entity_type='product') THEN
   INSERT INTO platform.outbox(id,event_type,payload)
   VALUES(gen_random_uuid(),'catalog.search_translations_updated','{}'::jsonb);
 END IF;
 RETURN NULL;
END
$$;
CREATE TRIGGER catalog_translation_search_changed
 AFTER INSERT OR UPDATE OR DELETE ON cms.catalog_translations
 FOR EACH ROW EXECUTE FUNCTION cms.notify_search_translation();

CREATE FUNCTION cms.notify_search_languages() RETURNS trigger
 LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO platform.outbox(id,event_type,payload)
 VALUES(gen_random_uuid(),'catalog.search_translations_updated','{}'::jsonb);
 RETURN NULL;
END
$$;
CREATE TRIGGER search_languages_changed
 AFTER INSERT OR UPDATE OR DELETE ON cms.storefront_languages
 FOR EACH STATEMENT EXECUTE FUNCTION cms.notify_search_languages();
CREATE TRIGGER search_source_language_changed
 AFTER INSERT OR UPDATE OR DELETE ON cms.language_settings
 FOR EACH STATEMENT EXECUTE FUNCTION cms.notify_search_languages();
