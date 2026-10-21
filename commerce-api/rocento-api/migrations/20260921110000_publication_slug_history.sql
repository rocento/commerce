-- Installation-local alias reservations survive deletion. No cross-database/tenant routing.
CREATE TABLE platform.publication_aliases (
 resource_kind text NOT NULL CHECK(resource_kind IN ('products','categories')),
 route_key text NOT NULL,
 resource_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(resource_kind,route_key)
);
CREATE INDEX publication_alias_resource ON platform.publication_aliases(resource_kind,resource_id);

CREATE FUNCTION platform.public_slug(value text) RETURNS text LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE result text := lower(normalize(value,NFKD)); source text[]; target text[]; i integer;
BEGIN
 result := regexp_replace(result, U&'[\0300-\036f]', '', 'g');
 result := translate(result,'àáâãäåāăąçćčďđèéêëēĕėęěìíîïīįıñńňòóôõöøōőùúûüūůűųýÿžźż','aaaaaaaaacccddeeeeeeeeeiiiiiiinnnoooooooouuuuuuuuyyzzz');
 result := replace(replace(replace(replace(result,'ß','ss'),'æ','ae'),'œ','oe'),'þ','th');
 source := ARRAY['أ','إ','آ','ٱ','ا','ب','ت','ث','ج','ح','خ','د','ذ','ر','ز','س','ش','ص','ض','ط','ظ','ع','غ','ف','ق','ك','ل','م','ن','ه','و','ؤ','ي','ئ','ى','ة','ء','٠','١','٢','٣','٤','٥','٦','٧','٨','٩'];
 target := ARRAY['a','a','a','a','a','b','t','th','j','h','kh','d','dh','r','z','s','sh','s','d','t','z','a','gh','f','q','k','l','m','n','h','w','w','y','y','a','h','','0','1','2','3','4','5','6','7','8','9'];
 FOR i IN 1..array_length(source,1) LOOP result := replace(result,source[i],target[i]); END LOOP;
 result := regexp_replace(result,U&'[\0640\064b-\065f\0670]','','g');
 result := trim(both '-' FROM regexp_replace(result,'[^a-z0-9]+','-','g'));
 RETURN trim(trailing '-' FROM left(result,100));
END $$;

CREATE FUNCTION platform.reserve_public_slug() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text := TG_TABLE_NAME; generated boolean := trim(NEW.slug)=''; base text; owner uuid; candidate text;
BEGIN
 -- Match the domain catalog's existing transaction lock; consistent lock ordering for API/import writes.
 PERFORM pg_advisory_xact_lock(2002);
 base := platform.public_slug(CASE WHEN generated THEN NEW.name ELSE NEW.slug END);
 IF base='' THEN base := CASE kind WHEN 'products' THEN 'product' ELSE 'category' END || '-' || replace(NEW.id::text,'-',''); END IF;
 IF base IN ('new','edit','admin','api','search','cart','checkout','account','login','register','robots','sitemap','feed','null','undefined') OR base ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
   base := CASE kind WHEN 'products' THEN 'product' ELSE 'category' END || '-' || base;
 END IF;
 candidate := base;
 SELECT resource_id INTO owner FROM platform.publication_aliases WHERE resource_kind=kind AND route_key=candidate;
 IF (owner IS NOT NULL AND owner<>NEW.id) OR (owner IS NULL AND EXISTS(SELECT 1 FROM platform.publication_routes WHERE path='/'||kind||'/'||candidate)) THEN
   IF NOT generated THEN RAISE EXCEPTION 'Public slug is already reserved' USING ERRCODE='23505'; END IF;
   candidate := base || '-' || replace(NEW.id::text,'-','');
 END IF;
 IF EXISTS(SELECT 1 FROM platform.publication_routes WHERE path='/'||kind||'/'||candidate) AND NOT EXISTS(SELECT 1 FROM platform.publication_aliases WHERE resource_kind=kind AND route_key=candidate AND resource_id=NEW.id) THEN
   RAISE EXCEPTION 'Public route has an approved redirect or retirement' USING ERRCODE='23505';
 END IF;
 -- Preserve the prior spelling, including migration-era aliases.
 IF TG_OP='UPDATE' AND OLD.slug<>candidate THEN
   INSERT INTO platform.publication_aliases(resource_kind,route_key,resource_id) VALUES(kind,lower(OLD.slug),NEW.id) ON CONFLICT DO NOTHING;
 END IF;
 FOR base IN SELECT unnest(ARRAY[candidate,NEW.id::text]) LOOP
   INSERT INTO platform.publication_aliases(resource_kind,route_key,resource_id) VALUES(kind,base,NEW.id) ON CONFLICT DO NOTHING;
   SELECT resource_id INTO owner FROM platform.publication_aliases WHERE resource_kind=kind AND route_key=base;
   IF owner<>NEW.id THEN RAISE EXCEPTION 'Public route is already reserved' USING ERRCODE='23505'; END IF;
 END LOOP;
 NEW.slug := candidate;
 RETURN NEW;
END $$;

-- Reserve existing values before normalization so migration cannot steal another record's URL.
INSERT INTO platform.publication_aliases(resource_kind,route_key,resource_id)
 SELECT 'products',lower(slug),id FROM catalog.products UNION ALL SELECT 'categories',lower(slug),id FROM catalog.categories;
CREATE TRIGGER publication_product_slug BEFORE INSERT OR UPDATE OF slug ON catalog.products FOR EACH ROW EXECUTE FUNCTION platform.reserve_public_slug();
CREATE TRIGGER publication_category_slug BEFORE INSERT OR UPDATE OF slug ON catalog.categories FOR EACH ROW EXECUTE FUNCTION platform.reserve_public_slug();
UPDATE catalog.products SET slug=slug;
UPDATE catalog.categories SET slug=slug;
