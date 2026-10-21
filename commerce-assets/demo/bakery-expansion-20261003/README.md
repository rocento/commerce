# Ten distinct bakery products

Production additions to `grocery-bakery`: sourdough, baguettes, ciabatta, rosemary
focaccia, brioche burger buns, soft pretzels, English muffins, cinnamon rolls,
chocolate chip muffins, and apple turnovers. Uses existing USD demo prices and
attribute options, ten attribute values per product, distinct illustrative
photos, and 30 initial demo units at each primary enabled fulfillment source.

`manifest.json` contains English source products. `translations-ar.json` contains
five Arabic text fields per product, saved with source/revision concurrency
checks and marked reviewed. Existing shared attribute labels/options already
have reviewed Arabic translations.

Run `scripts/add-bakery-products-20261003.py --assets <uploaded-assets>` from
`/opt/rocento` to preview; add `--apply` to create and translate. Uses server-side
credentials, verified origin HTTPS, deployment lock, conflict and attribute-option
preflight, a catalog snapshot, and English/Arabic public API and inventory checks.
Existing products and assigned inventory are preserved on reruns. Product images
use built-in imagegen, one white-background studio photo per item. Ingredient and
allergen details are not supplied in this demo catalog.
