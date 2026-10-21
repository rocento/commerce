#!/usr/bin/env python3
"""Generate 50 grocery demo products. Preview by default; use --apply to create."""
from decimal import Decimal
from demo_seed import run

CATEGORIES = {'fresh-produce': 'Fresh Produce',
 'baladi-bakery': 'Baladi Bakery',
 'egyptian-breakfast': 'Egyptian Breakfast',
 'pantry-staples': 'Pantry Staples',
 'cheese-dairy': 'Cheese & Dairy',
 'dates-nuts-sweets': 'Dates, Nuts & Sweets',
 'tea-cold-drinks': 'Tea & Cold Drinks',
 'household-basics': 'Household Basics'}

# Image slug, product name, assigned category, USD demo price.
ITEMS = [('organic-bananas', 'Bananas 1kg', 'fresh-produce', '1.50'),
 ('gala-apples', 'Gala Apples 1kg', 'fresh-produce', '3.50'),
 ('whole-milk', 'Whole Milk 1L', 'cheese-dairy', '1.80'),
 ('baladi-bread', 'Baladi Bread 5 Loaves', 'baladi-bakery', '1.20'),
 ('egyptian-rice', 'Egyptian Rice 1kg', 'pantry-staples', '2.00'),
 ('dried-fava-beans', 'Dried Fava Beans 500g', 'egyptian-breakfast', '1.60'),
 ('fresh-molokhia', 'Fresh Molokhia 250g', 'fresh-produce', '0.90'),
 ('roumi-cheese', 'Roumi Cheese 250g', 'cheese-dairy', '3.20'),
 ('medjool-dates', 'Medjool Dates 400g', 'dates-nuts-sweets', '4.50'),
 ('tahini-jar', 'Tahini Jar 350g', 'pantry-staples', '2.80'),
 ('baladi-ghee', 'Baladi Ghee 500g', 'pantry-staples', '5.50'),
 ('karkadeh-hibiscus', 'Dried Hibiscus 200g', 'tea-cold-drinks', '1.90'),
 ('egyptian-cucumbers', 'Egyptian Cucumbers 1kg', 'fresh-produce', '1.10'),
 ('roma-tomatoes', 'Roma Tomatoes 1kg', 'fresh-produce', '1.20'),
 ('egyptian-lemons', 'Egyptian Lemons 500g', 'fresh-produce', '1.30'),
 ('fresh-mint', 'Fresh Mint Bunch', 'fresh-produce', '0.50'),
 ('cane-sugar', 'Cane Sugar 1kg', 'pantry-staples', '1.40'),
 ('red-lentils', 'Red Lentils 500g', 'pantry-staples', '1.80'),
 ('dish-soap', 'Dish Soap 650ml', 'household-basics', '2.20'),
 ('fresh-oranges', 'Fresh Oranges 1kg', 'fresh-produce', '1.60'),
 ('fresh-strawberries', 'Fresh Strawberries 500g', 'fresh-produce', '2.50'),
 ('fresh-potatoes', 'Golden Potatoes 1kg', 'fresh-produce', '1.00'),
 ('red-onions', 'Red Onions 1kg', 'fresh-produce', '0.90'),
 ('fresh-carrots', 'Fresh Carrots 500g', 'fresh-produce', '0.80'),
 ('farm-eggs', 'Farm Eggs 6 Pack', 'cheese-dairy', '2.40'),
 ('plain-yogurt', 'Plain Yogurt 500g', 'cheese-dairy', '1.60'),
 ('olive-oil', 'Olive Oil 500ml', 'pantry-staples', '6.00'),
 ('penne-pasta', 'Penne Pasta 500g', 'pantry-staples', '1.70'),
 ('raw-almonds', 'Raw Almonds 250g', 'dates-nuts-sweets', '4.20'),
 ('wildflower-honey', 'Wildflower Honey 350g', 'egyptian-breakfast', '3.80')]


def products():
    result = []
    for index, (slug, name, category, price) in enumerate(ITEMS, 1):
        result.append(dict(sku=f'DEMO-GRO-50-{index:03}', slug='demo-grocery-' + slug,
            name=name, category=category, price=price, unit='pack', image=slug + '.png',
            description=f'{name}. Grocery demo product; package appearance is illustrative.'))
    for index, original in enumerate(result[:20], 31):
        result.append(dict(original, sku=f'DEMO-GRO-50-{index:03}',
            slug=original['slug'] + '-double-pack', name=original['name'] + ' — Double Pack',
            price=str((Decimal(original['price']) * Decimal('1.85')).quantize(Decimal('0.01'))),
            description=f"Two packs of {original['name']}. Demo image shows one standard pack or serving."))
    return result


if __name__ == '__main__':
    run('grocery', CATEGORIES, products())
