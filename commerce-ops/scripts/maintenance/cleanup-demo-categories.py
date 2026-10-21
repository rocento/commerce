"""Keep only storefront menu categories in the local demo, preserving all products.

Run without arguments to preview, or with --apply-local to save a backup and apply.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import datetime
import json
import re

from m8_db import ROOT, pg

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--apply-local', action='store_true')
args = parser.parse_args()
source = (ROOT / 'commerce-web/apps/storefront/src/catalog.tsx').read_text()
slugs = re.findall(r'"([a-z-]+)"', source.split('const shopperCategorySlugs = [', 1)[1].split('];', 1)[0])
assert len(slugs) == 8, 'Review changed storefront menu before cleanup'
keep = ','.join("'" + slug + "'" for slug in slugs)

# Map ordinary child categories to their menu parent; group legacy fixtures by
# product type. Pantry is the fallback for mixed grocery/meat demo fixtures.
mapping = f"""
CREATE TEMP TABLE category_moves AS
SELECT p.id, p.category_id AS old_category_id, target.id AS new_category_id
FROM catalog.products p
JOIN catalog.categories c ON c.id=p.category_id
JOIN catalog.categories target ON target.slug = CASE
 WHEN c.slug IN ('fruit','fruits','produce','vegetables-herbs') OR c.name LIKE 'Produce demo %' OR c.name LIKE 'Frozen demo %' THEN 'fresh-produce'
 WHEN c.slug IN ('milk','milk-yogurt','dairy-eggs') OR c.name LIKE 'Dairy demo %' THEN 'cheese-dairy'
 WHEN c.name LIKE 'Bakery demo %' THEN 'baladi-bakery'
 WHEN c.name LIKE 'Beverages demo %' THEN 'tea-cold-drinks'
 WHEN c.name LIKE 'Snacks demo %' THEN 'dates-nuts-sweets'
 WHEN c.name ~ '^(Household|Personal care|Baby|Pet) demo ' THEN 'household-basics'
 WHEN c.slug IN ('cooking-essentials','rice-pasta-pulses') THEN 'pantry-staples'
 WHEN lower(p.name) ~ '(milk|yogurt|eggs|parmesan|feta|cheese)' THEN 'cheese-dairy'
 WHEN lower(p.name) ~ '(almonds|dates|biscuits)' THEN 'dates-nuts-sweets'
 WHEN lower(p.name) ~ '(bananas|oranges|basil|mushrooms|cucumber|lemon|lettuce|mint)' OR lower(p.name) = 'salad tomatoes' THEN 'fresh-produce'
 WHEN lower(p.name) LIKE '%bread%' THEN 'baladi-bakery'
 WHEN lower(p.name) LIKE '%black tea%' THEN 'tea-cold-drinks'
 WHEN lower(p.name) LIKE '%breakfast basics%' THEN 'egyptian-breakfast'
 ELSE 'pantry-staples'
END
WHERE c.slug NOT IN ({keep});
"""
snapshot = json.loads(pg("SELECT json_build_object('categories',(SELECT json_agg(c) FROM catalog.categories c),'products',(SELECT json_agg(json_build_object('id',id,'category_id',category_id,'updated_at',updated_at,'active',active)) FROM catalog.products));"))
present = {c['slug'] for c in snapshot['categories']}
assert set(slugs) <= present, 'A menu category is missing'
removed = [c for c in snapshot['categories'] if c['slug'] not in slugs]
print(json.dumps({'keep': slugs, 'remove_categories': len(removed), 'preserve_products': len(snapshot['products'])}))
if not args.apply_local:
    print(pg('BEGIN;\n' + mapping + '\nSELECT c.name,count(*) FROM category_moves m JOIN catalog.categories c ON c.id=m.new_category_id GROUP BY c.name ORDER BY c.name;\nROLLBACK;'))
    raise SystemExit(0)
if not removed:
    print('Already clean.')
    raise SystemExit(0)
backup = ROOT / '.local' / ('category-cleanup-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '.json')
backup.write_text(json.dumps(snapshot, indent=2))
backup.chmod(0o600)
print('Backup:', backup)
print(pg(f"""
BEGIN;
SELECT pg_advisory_xact_lock(2002);
LOCK TABLE catalog.categories, catalog.products IN SHARE ROW EXCLUSIVE MODE;
{mapping}
CREATE TEMP TABLE product_counts AS SELECT count(*) total,count(*) FILTER (WHERE active) active FROM catalog.products;
UPDATE catalog.products p SET category_id=m.new_category_id,updated_at=now() FROM category_moves m WHERE p.id=m.id;
UPDATE catalog.categories SET parent_id=NULL WHERE slug NOT IN ({keep});
DELETE FROM catalog.categories WHERE slug NOT IN ({keep});
INSERT INTO platform.outbox(id,event_type,payload)
SELECT gen_random_uuid(),'catalog.category_updated',jsonb_build_object('id',id) FROM catalog.categories;
DO $$ BEGIN
 IF (SELECT count(*) FROM catalog.categories) <> 8 THEN RAISE EXCEPTION 'Unexpected remaining categories'; END IF;
 IF (SELECT count(*) FROM catalog.products) <> (SELECT total FROM product_counts) THEN RAISE EXCEPTION 'Product count changed'; END IF;
 IF (SELECT count(*) FROM catalog.products WHERE active) <> (SELECT active FROM product_counts) THEN RAISE EXCEPTION 'Product visibility changed'; END IF;
END $$;
SELECT json_build_object('removed_categories',{len(removed)},'reassigned_products',(SELECT count(*) FROM category_moves),'remaining_categories',(SELECT count(*) FROM catalog.categories),'preserved_products',(SELECT count(*) FROM catalog.products));
COMMIT;
"""))
