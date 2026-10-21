"""Create an Egypt grocery demo catalog via the real API; existing SKUs remain untouched."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

from catalog_support import Client, ROOT

client = Client()
categories = {c['slug']: c for c in client.call('GET', '/v1/catalog/categories')}
for name, slug, parent in [
    ('Fresh Produce', 'fresh-produce', None),
    ('Fruit', 'fruit', 'fresh-produce'),
    ('Vegetables & Herbs', 'vegetables-herbs', 'fresh-produce'),
    ('Cheese & Dairy', 'cheese-dairy', None),
    ('Milk & Yogurt', 'milk-yogurt', 'cheese-dairy'),
    ('Egyptian Breakfast', 'egyptian-breakfast', None),
    ('Baladi Bakery', 'baladi-bakery', None),
    ('Pantry Staples', 'pantry-staples', None),
    ('Rice, Pasta & Pulses', 'rice-pasta-pulses', 'pantry-staples'),
    ('Cooking Essentials', 'cooking-essentials', 'pantry-staples'),
    ('Dates, Nuts & Sweets', 'dates-nuts-sweets', None),
    ('Tea & Cold Drinks', 'tea-cold-drinks', None),
    ('Household Basics', 'household-basics', None),
]:
    if slug not in categories:
        categories[slug] = client.call('POST', '/v1/admin/catalog/categories', {'name': name, 'slug': slug, 'parent_id': categories[parent]['id'] if parent else None})
attributes = {a['code']: a for a in client.call('GET', '/v1/admin/catalog/attributes')}
for name, code, kind in [('Organic', 'organic', 'boolean'), ('Brand', 'brand', 'text'), ('Color', 'color', 'text'), ('Product kind', 'product-kind', 'text')]:
    if code not in attributes:
        client.call('POST', '/v1/admin/catalog/attributes', {'name': name, 'code': code, 'kind': kind, 'required': False})
existing = {}
offset = 0
while True:
    rows = client.call('GET', f'/v1/admin/catalog/products?offset={offset}')
    existing.update((p['sku'], p) for p in rows)
    if len(rows) < 50:
        break
    offset += 50
for sku, name, slug, price, unit, category, organic, stock, description in [
    ('DEMO-BRD-001', 'Baladi Bread Pack', 'baladi-bread', '12.00', 'pack', 'baladi-bakery', False, True, 'Soft round baladi loaves for everyday Egyptian breakfasts, sandwiches, and family meals.'),
    ('DEMO-RCE-001', 'Egyptian White Rice 1kg', 'egyptian-rice', '42.00', 'kg', 'rice-pasta-pulses', False, True, 'Short-grain Egyptian white rice for mahshi, molokhia plates, and weeknight cooking.'),
    ('DEMO-FUL-001', 'Dried Fava Beans 500g', 'dried-fava-beans', '38.00', 'pack', 'egyptian-breakfast', False, True, 'Dry fava beans ready for classic ful medames, soaking, and slow cooking.'),
    ('DEMO-MOL-001', 'Fresh Molokhia Bunch', 'fresh-molokhia', '18.00', 'pack', 'vegetables-herbs', False, True, 'Fresh molokhia leaves for a green, comforting Egyptian soup served with rice or bread.'),
    ('DEMO-ROM-001', 'Roumi Cheese Wedge', 'roumi-cheese', '96.00', 'pack', 'cheese-dairy', False, True, 'Sharp, salty roumi cheese wedge for sandwiches, breakfast plates, and grating.'),
    ('DEMO-DAT-001', 'Medjool Dates 400g', 'medjool-dates', '110.00', 'pack', 'dates-nuts-sweets', False, True, 'Soft, caramel-sweet dates for snacking, Ramadan tables, and dessert boxes.'),
    ('DEMO-TAH-001', 'Plain Tahini Jar 350g', 'tahini-jar', '58.00', 'pack', 'cooking-essentials', False, True, 'Creamy sesame tahini for taameya, grilled meats, salads, and dips.'),
    ('DEMO-GHE-001', 'Baladi Ghee Jar 500g', 'baladi-ghee', '145.00', 'pack', 'cooking-essentials', False, True, 'Golden clarified butter for Egyptian home cooking, rice, pastries, and frying aromatics.'),
    ('DEMO-KRK-001', 'Karkadeh Hibiscus 200g', 'karkadeh-hibiscus', '48.00', 'pack', 'tea-cold-drinks', False, True, 'Dried hibiscus flowers for hot tea or cold karkadeh with a deep ruby color.'),
    ('DEMO-CUC-001', 'Egyptian Cucumbers', 'egyptian-cucumbers', '22.00', 'kg', 'vegetables-herbs', False, True, 'Small crisp cucumbers for salads, cheese sandwiches, and lunch plates.'),
    ('DEMO-TOM-001', 'Roma Tomatoes', 'roma-tomatoes', '24.00', 'kg', 'vegetables-herbs', False, True, 'Ripe red tomatoes for salads, sauces, fasolia, and everyday cooking.'),
    ('DEMO-LEM-001', 'Egyptian Lemons', 'egyptian-lemons', '32.00', 'kg', 'fruit', False, True, 'Bright yellow-green lemons for tea, soups, marinades, and fresh salads.'),
    ('DEMO-MNT-001', 'Fresh Mint Bunch', 'fresh-mint', '10.00', 'pack', 'vegetables-herbs', False, True, 'Fresh mint leaves for tea, salads, lemon juice, and garnishes.'),
    ('DEMO-SGR-001', 'Cane Sugar 1kg', 'cane-sugar', '36.00', 'kg', 'cooking-essentials', False, True, 'Everyday white cane sugar for tea, baking, and pantry restocking.'),
    ('DEMO-LEN-001', 'Red Lentils 500g', 'red-lentils', '46.00', 'pack', 'rice-pasta-pulses', False, True, 'Split red lentils for quick soups, koshari sides, and hearty pantry meals.'),
    ('DEMO-SOP-001', 'Dish Soap 650ml', 'dish-soap', '55.00', 'each', 'household-basics', False, True, 'Lemon-scent style dish soap for daily kitchen cleanup in the household aisle.'),
    ('DEMO-BAN-001', 'Local Bananas', 'organic-bananas', '34.00', 'kg', 'fruit', False, True, 'Sweet yellow bananas for lunchboxes, smoothies, and quick snacks.'),
    ('DEMO-APL-001', 'Red Apples', 'gala-apples', '88.00', 'kg', 'fruit', False, True, 'Crisp red apples for fruit bowls, school snacks, and fresh desserts.'),
    ('DEMO-MLK-001', 'Whole Milk 1L', 'whole-milk', '42.00', 'L', 'milk-yogurt', False, False, 'Fresh whole milk in a one-liter bottle. Keep refrigerated. This demo item is temporarily out of stock.'),
]:
    product = existing.get(sku)
    media_ids = product['media_ids'] if product else []
    if not media_ids:
        media = client.upload((ROOT / f'commerce-assets/demo/{slug}.png').read_bytes(), name + ' — demo product image')
        media_ids = [media['id']]
    payload = {'sku': sku, 'name': name, 'slug': slug, 'price': price, 'unit': unit, 'currency': 'USD', 'description': description, 'category_id': categories[category]['id'], 'attributes': {'organic': organic, 'brand': 'Commerce Demo'}, 'media_ids': media_ids, 'active': True, 'in_stock': stock}
    if sku == 'DEMO-APL-001':
        payload['attributes'].update({'color': 'red', 'product-kind': 'fruit'})
    if product:
        client.call('PUT', f'/v1/admin/catalog/products/{product["id"]}', payload)
        print(f'Updated {name}')
    else:
        client.call('POST', '/v1/admin/catalog/products', payload)
        print(f'Created {name}')
client.call('POST', '/v1/admin/auth/logout')
print('Demo catalog ready. Search updates through the outbox and NATS consumer.')
