#!/usr/bin/env python3
"""Generate 50 jewelry demo products. Preview by default; use --apply to create."""
from demo_seed import run

CATEGORIES = {'jewelry-rings': 'Rings',
 'jewelry-earrings': 'Earrings',
 'jewelry-necklaces': 'Necklaces',
 'jewelry-bracelets': 'Bracelets',
 'jewelry-accessories': 'Jewelry Accessories'}

# Image slug, product name, assigned category, USD demo price.
ITEMS = [('gold-solitaire-ring', 'Gold Solitaire Ring — US Size 6', 'jewelry-rings', '249.00'),
 ('silver-halo-ring', 'Silver Halo Ring — US Size 6', 'jewelry-rings', '189.00'),
 ('emerald-gold-ring', 'Emerald Gold Ring — US Size 6', 'jewelry-rings', '399.00'),
 ('sapphire-silver-ring', 'Sapphire Silver Ring — US Size 6', 'jewelry-rings', '329.00'),
 ('ruby-gold-ring', 'Ruby Gold Ring — US Size 6', 'jewelry-rings', '349.00'),
 ('rose-gold-band', 'Rose Gold Band — US Size 6', 'jewelry-rings', '99.00'),
 ('gold-signet-ring', 'Gold Signet Ring — US Size 6', 'jewelry-rings', '219.00'),
 ('silver-twist-ring', 'Silver Twist Ring — US Size 6', 'jewelry-rings', '89.00'),
 ('gold-hoop-earrings', 'Gold Hoop Earrings', 'jewelry-earrings', '129.00'),
 ('pearl-stud-earrings', 'Pearl Stud Earrings', 'jewelry-earrings', '79.00'),
 ('diamond-stud-earrings', 'Diamond Stud Earrings', 'jewelry-earrings', '199.00'),
 ('emerald-drop-earrings', 'Emerald Drop Earrings', 'jewelry-earrings', '229.00'),
 ('silver-huggie-earrings', 'Silver Huggie Earrings', 'jewelry-earrings', '59.00'),
 ('rose-gold-chain-earrings', 'Rose Gold Chain Earrings', 'jewelry-earrings', '89.00'),
 ('sapphire-cluster-earrings', 'Sapphire Cluster Earrings', 'jewelry-earrings', '179.00'),
 ('gold-chain-necklace', 'Gold Chain Necklace — 45cm', 'jewelry-necklaces', '159.00'),
 ('pearl-strand-necklace', 'Pearl Strand Necklace — 45cm', 'jewelry-necklaces', '149.00'),
 ('heart-pendant-necklace', 'Heart Pendant Necklace — 45cm', 'jewelry-necklaces', '109.00'),
 ('emerald-pendant-necklace', 'Emerald Pendant Necklace — 45cm', 'jewelry-necklaces', '249.00'),
 ('silver-moon-necklace', 'Silver Moon Necklace — 45cm', 'jewelry-necklaces', '69.00'),
 ('diamond-pendant-necklace', 'Diamond Pendant Necklace — 45cm', 'jewelry-necklaces', '199.00'),
 ('gold-tennis-bracelet', 'Gold Tennis Bracelet', 'jewelry-bracelets', '299.00'),
 ('silver-cuff-bracelet', 'Silver Cuff Bracelet', 'jewelry-bracelets', '99.00'),
 ('gold-bangle-bracelet', 'Gold Bangle Bracelet', 'jewelry-bracelets', '199.00'),
 ('pearl-bracelet', 'Pearl Bracelet', 'jewelry-bracelets', '69.00'),
 ('rose-gold-link-bracelet', 'Rose Gold Link Bracelet', 'jewelry-bracelets', '139.00'),
 ('silver-charm-bracelet', 'Silver Charm Bracelet', 'jewelry-bracelets', '89.00'),
 ('gold-anklet', 'Gold Anklet', 'jewelry-accessories', '79.00'),
 ('pearl-gold-brooch', 'Pearl Gold Brooch', 'jewelry-accessories', '149.00'),
 ('onyx-silver-cufflinks', 'Onyx Silver Cufflinks', 'jewelry-accessories', '119.00')]


def products():
    result = []
    for index, (slug, name, category, price) in enumerate(ITEMS, 1):
        result.append(dict(sku=f'DEMO-JWL-50-{index:03}', slug='demo-jewelry-' + slug,
            name=name, category=category, price=price, unit='each', image='jewelry/' + slug + '.png',
            description=f'{name}. Synthetic jewelry demo; materials and gemstones are illustrative, not certified specifications.'))
    for size in (7, 8):
        for original in result[:8]:
            result.append(dict(original, sku=f'DEMO-JWL-50-{len(result) + 1:03}',
                slug=original['slug'] + f'-size-{size}', name=original['name'].replace('Size 6', f'Size {size}'),
                description=f'US ring size {size}. Uses the same illustrative design image as the size 6 demo.'))
    for original in result[15:19]:
        result.append(dict(original, sku=f'DEMO-JWL-50-{len(result) + 1:03}',
            slug=original['slug'] + '-50cm', name=original['name'].replace('45cm', '50cm'),
            description='50cm necklace. Uses the same illustrative design image as the 45cm demo.'))
    return result


if __name__ == '__main__':
    run('jewelry', CATEGORIES, products())
