-- Keep the primary category for stable breadcrumbs. The array is the product
-- read model; the membership table supplies foreign-key integrity and reverse lookup.
ALTER TABLE catalog.products ADD COLUMN category_ids uuid[] NOT NULL DEFAULT '{}';
UPDATE catalog.products SET category_ids=ARRAY[category_id];
CREATE TABLE catalog.product_categories (
 product_id uuid NOT NULL REFERENCES catalog.products(id) ON DELETE CASCADE,
 category_id uuid NOT NULL REFERENCES catalog.categories(id) ON DELETE RESTRICT,
 PRIMARY KEY(product_id,category_id)
);
CREATE INDEX product_categories_category ON catalog.product_categories(category_id,product_id);
CREATE INDEX products_category_ids ON catalog.products USING gin(category_ids);
INSERT INTO catalog.product_categories SELECT id,category_id FROM catalog.products;
CREATE FUNCTION catalog.normalize_product_categories() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 NEW.category_ids := ARRAY(SELECT DISTINCT c FROM unnest(NEW.category_ids || ARRAY[NEW.category_id]) c WHERE c IS NOT NULL ORDER BY c);
 IF cardinality(NEW.category_ids)>50 THEN RAISE EXCEPTION 'A product may have at most 50 categories' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER normalize_product_categories BEFORE INSERT OR UPDATE OF category_id,category_ids ON catalog.products FOR EACH ROW EXECUTE FUNCTION catalog.normalize_product_categories();
CREATE FUNCTION catalog.sync_product_categories() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM catalog.product_categories WHERE product_id=NEW.id AND NOT(category_id=ANY(NEW.category_ids));
 INSERT INTO catalog.product_categories SELECT NEW.id,unnest(NEW.category_ids) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER sync_product_categories AFTER INSERT OR UPDATE OF category_id,category_ids ON catalog.products FOR EACH ROW EXECUTE FUNCTION catalog.sync_product_categories();
