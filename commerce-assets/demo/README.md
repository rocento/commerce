# M2 demo images

These synthetic catalog photographs were generated using the built-in imagegen tool and copied
into this repository. They illustrate demo products, not an actual supplier's packaging or
inventory. `commerce-ops/scripts/demo/seed-catalog.py` uploads them through the real MinIO-backed API.

## Prompts

- `organic-bananas.png`: Use case: product-mockup. Create a square grocery catalog product photograph of one small bunch of five ripe organic yellow bananas, unbranded, no stickers, centered entirely within frame, on a plain warm ivory background (#f3f4ed), soft natural studio light, subtle grounded shadow, realistic peel texture, generous clean margins, no text, no labels, no hands, no other food. This is a product image asset for a grocery storefront.
- `gala-apples.png`: Use case: product-mockup. Square grocery catalog product photograph of three fresh red gala apples, one apple with a small natural green leaf, centered entirely within the frame on a plain warm ivory background (#f3f4ed). Soft natural studio lighting, realistic skin texture, subtle grounded shadows, generous clean margins. No packaging, text, stickers, branding, hands, or other food.
- `whole-milk.png`: Use case: product-mockup. Square grocery catalog product photograph of a single one-liter clear glass bottle filled with fresh whole milk, simple silver metal cap, no branding, no labels. Centered entirely within frame on plain warm ivory background (#f3f4ed), soft natural studio lighting, realistic glass and milk texture, subtle grounded shadow, generous clean margins. No text, hands, props, or other food.
- `baladi-bread.png`: Use case: product-mockup. Square grocery catalog product photograph of a small stack of round Egyptian baladi flatbread loaves, rustic whole wheat texture, plain warm ivory background (#f3f4ed), soft studio light, subtle shadow, no text, no labels, no hands.
- `egyptian-rice.png`: Use case: product-mockup. Square grocery catalog product photograph of short-grain white rice in an open unbranded cloth sack with a small spill of grains, plain warm ivory background (#f3f4ed), soft studio light, no text or branding.
- `dried-fava-beans.png`: Use case: product-mockup. Square grocery catalog product photograph of dried fava beans in a clear unbranded glass jar with loose beans in front, plain warm ivory background (#f3f4ed), soft studio light, no text or labels.
- `fresh-molokhia.png`: Use case: product-mockup. Square grocery catalog product photograph of a fresh bunch of green molokhia leaves and stems, plain warm ivory background (#f3f4ed), soft studio light, no packaging, no text.
- `roumi-cheese.png`: Use case: product-mockup. Square grocery catalog product photograph of a firm wedge of pale yellow Egyptian roumi cheese with a natural rind, plain warm ivory background (#f3f4ed), soft studio light, no packaging or text.
- `medjool-dates.png`: Use case: product-mockup. Square grocery catalog product photograph of glossy brown Medjool dates with natural wrinkled skins, plain warm ivory background (#f3f4ed), soft studio light, no packaging or text.
- `tahini-jar.png`: Use case: product-mockup. Square grocery catalog product photograph of a clear unbranded glass jar of creamy beige tahini with a simple lid, plain warm ivory background (#f3f4ed), soft studio light, no label or text.
- `baladi-ghee.png`: Use case: product-mockup. Square grocery catalog product photograph of golden clarified butter ghee in a clear unbranded glass jar with a simple lid, plain warm ivory background (#f3f4ed), soft studio light, no label or text.
- `karkadeh-hibiscus.png`: Use case: product-mockup. Square grocery catalog product photograph of a neat mound of deep red dried hibiscus flowers, plain warm ivory background (#f3f4ed), soft studio light, no cup, packaging, or text.
- `egyptian-cucumbers.png`: Use case: product-mockup. Square grocery catalog product photograph of small fresh Egyptian cucumbers arranged in a tidy natural pile, plain warm ivory background (#f3f4ed), soft studio light, no packaging or text.
- `roma-tomatoes.png`: Use case: product-mockup. Square grocery catalog product photograph of ripe red Roma tomatoes with one sliced open, plain warm ivory background (#f3f4ed), soft studio light, no packaging or text.
- `egyptian-lemons.png`: Use case: product-mockup. Square grocery catalog product photograph of small yellow-green Egyptian lemons with fresh citrus texture, plain warm ivory background (#f3f4ed), soft studio light, no packaging or text.
- `fresh-mint.png`: Use case: product-mockup. Square grocery catalog product photograph of a fresh bunch of green mint leaves and stems, plain warm ivory background (#f3f4ed), soft studio light, no packaging or text.
- `cane-sugar.png`: Use case: product-mockup. Square grocery catalog product photograph of white granulated cane sugar in an open unbranded paper bag with a small spill, plain warm ivory background (#f3f4ed), soft studio light, no printed packaging or text.
- `red-lentils.png`: Use case: product-mockup. Square grocery catalog product photograph of orange-red split lentils in a small open burlap sack with loose lentils in front, plain warm ivory background (#f3f4ed), soft studio light, no text or labels.
- `dish-soap.png`: Use case: product-mockup. Square grocery catalog product photograph of a simple unbranded transparent plastic bottle filled with golden dish soap and a plain white pump cap, plain warm ivory background (#f3f4ed), soft studio light, no label or text.


## Expanded demo collections

### Product generators

Run from the repository root with Python 3 (standard library only):

```sh
# Preview the full product/category data; no login or writes.
python3 commerce-assets/demo/generate-grocery.py
python3 commerce-assets/demo/generate-jewelry.py

# Create each collection in its target store.
python3 commerce-assets/demo/generate-grocery.py --apply
python3 commerce-assets/demo/generate-jewelry.py --apply
```

Both scripts default to `http://localhost:5174/api`. Use `--api-base` to select
the appropriate grocery or jewelry store. Running both against the same API adds
both collections to that catalog. The scripts do not change storefront menus.

Authentication uses `.local/admin-credentials.txt` (`Email: ...` and `Password: ...`),
or `--credentials /path/to/file`. Alternatively set both `DEMO_ADMIN_EMAIL` and
`DEMO_ADMIN_PASSWORD` in the environment. Preview mode needs no credentials.

- Grocery: 50 products across the eight existing menu categories. Includes 30
  standard packs and 20 double packs, with the standard product image reused.
- Jewelry: 50 products across Rings, Earrings, Necklaces, Bracelets, and Jewelry
  Accessories. Includes 30 designs, 16 additional ring sizes, and four additional
  necklace lengths. Size variations are separate simple products.
- Missing categories are created by slug. Stable, collection-specific SKUs make
  reruns skip existing products, preserving administrator edits. Existing products
  are never deleted or replaced; this adds a 50-product collection, rather than
  resetting the store to 50 products.
- All products have an assigned category, image, demo USD price, and description.
  Images are uploaded through the catalog API and reused between variants.
- Products are active with `in_stock: true`; warehouse/source quantities and
  delivery availability are managed separately by the inventory system.
- `demo_seed.py` is the shared API helper required by both scripts. Keep it beside
  them along with the image files. A failed run can be resumed with the same command.

- Grocery: 30 product PNGs in this folder (19 original images plus 11 additions).
- Jewelry: 30 product PNGs in `jewelry/`.
- Open `catalog.html` to browse both collections.
- `image-generation-manifest.json` records the exact built-in image_gen prompt, product name, and destination for each of the 41 additions.
- These files are local demo assets; generating them does not upload or create catalog records.
