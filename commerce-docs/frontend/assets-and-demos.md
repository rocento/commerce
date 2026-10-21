# Assets, delivery data and demos

Shared Arabic fonts under `commerce-web/packages/ui/src/fonts` include Cairo, Tajawal and Noto Sans Arabic from the Google Fonts repository. Their SIL Open Font License files remain alongside the assets. Shared CSS bundles them for admin examples and storefront use.

Storefront public fonts include Google Fonts Bodoni Moda and Jost, with included SIL license files and theme-controlled loading. Jewelry reference assets Saol Display and Futura Now Headline are separate commercial reference fonts; the Google Fonts licenses do not cover them, and this repository does not include or imply their commercial licenses. Font files and license files were retained when their old READMEs were removed.

## Bundled address directory

[Delivery data](../../commerce-web/apps/storefront/public/data/delivery) covers Egypt, Saudi Arabia, Kuwait, the United States, the Netherlands and the United Kingdom. Country manifests record source archive hashes, counts and applicable exclusions; region IDs use GeoNames ADM1 and must not be assumed to be ISO subdivision codes. This is an offline picker, with regions loaded as needed and up to 60 matching options rendered at once.

The data credits GeoNames contributors under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). [GeoNames source format](https://download.geonames.org/export/dump/readme.txt) describes the upstream files. Locality coordinates are approximate and are not entrance pins. Missing/unassigned or excluded historical records mean this is not an exhaustive official register; customers can use map pins. Adding countries does not configure their delivery, tax, currency or payment policies.

To refresh a snapshot, use the source URL from its manifest, keep archives outside the repository and run the importer on a working copy:

```sh
python3 commerce-ops/scripts/demo/import-delivery-locations.py SA /path/to/SA.zip
python3 commerce-ops/scripts/demo/import-egypt-locations.py /path/to/EG.zip
python3 -m unittest discover -s commerce-ops/scripts/tests -p 'test_delivery_locations.py'
```

The international importer also supports the other bundled international countries. Review source names, counts and exclusions, then deploy each complete manifest/region set together. Do not overwrite an actively served directory during generation. Validate `delivery-geography.test.ts` and the relevant delivery browser suite when selection behavior or data changes.

## Demos

Demo catalog/category, grocery and jewelry source assets remain under [assets/demo](../../commerce-assets/demo). Existing asset manifests and non-documentation files are retained. Seed/import scripts can mutate a database: identify the intended installation, inspect inputs and use its approved environment. Corporate website demo cards only link to configured storefronts. A demo directory or UI preset alone does not establish stock, live delivery coverage or production readiness.

### Pharmacy & skincare — NOIR ROSÉ

The [pharmacy preset](../../commerce-demo/pharmacy/preset.json) contains 40 branded demo products from Estée Lauder, SkinCeuticals, Clarins, Clinique and La Roche-Posay across eight categories: Skincare, Cleansers, Face & Body, Pharmacy Essentials, Serums, Moisturizers, Eye & Lip Care, and Hand Care. Its [theme](../../commerce-demo/pharmacy/theme.json) uses the existing heritage presentation with black, bright rose and white, with clean Arial typography for English and bundled Tajawal for Arabic. Both fonts are selectable in the theme editor, including separate Arabic body and heading controls. The preset includes Arabic page copy, all 40 products and all eight categories; seeding registers English/Arabic and installs catalog translations without replacing administrator edits. Use the language switcher or `?lang=ar` to preview Arabic. It does not change other storefront themes. The five generated photographs and their exact built-in imagegen prompts are saved in [commerce-assets/demo/pharmacy](../../commerce-assets/demo/pharmacy/image-generation-manifest.json). The catalog uses original brand product photography; source URLs, hashes and image-rights status are recorded in [the brand source manifest](../../commerce-assets/demo/pharmacy/brands/source-manifest.json). USD prices are illustrative demo prices. The original 12 synthetic items are listed as retired SKUs, so seeding the new catalog deactivates those records without deleting IDs or order references. The original hero remains generated editorial artwork.

For a local, read-only design preview, build the storefront and run from the repository root:

```sh
cd commerce-web/apps/storefront
node ../../node_modules/vite/bin/vite.js build
cd ../../..
node commerce-ops/scripts/demo/preview-demo-storefront.mjs pharmacy
```

Open `http://127.0.0.1:5473`. The preview serves the real storefront UI with local preset data; accounts, checkout and persistence require an installed backend. An optional port and build directory can follow the preset argument. Set `NEXT_PUBLIC_PHARMACY_DEMO_URL` in the corporate website environment to enable its demo link, then rebuild the website. Use the localhost URL only for local development.

For the full demo, [compose.pharmacy.yaml](../../commerce-ops/compose/compose.pharmacy.yaml) defines an isolated `commerce-pharmacy` project with storefront port 5473, admin port 5474 and gateway port 60080. Stop the design preview before starting this stack. Configure the required `.env` values, start Docker, and initialize the separate installation and its administrator using the standard setup:

```sh
docker compose -p commerce-pharmacy -f commerce-ops/compose/compose.yaml -f commerce-ops/compose/compose.pharmacy.yaml up -d --build
python3 commerce-ops/scripts/demo/seed-demo-storefront.py pharmacy
# After the new installation and its admin credentials are ready:
python3 commerce-ops/scripts/demo/seed-demo-storefront.py pharmacy --apply --publish --complete --api-base http://127.0.0.1:60080 --credentials /path/to/pharmacy-admin-credentials.txt
```

The seed supports reruns, global demo inventory, and the existing optional Egypt delivery enrichment. Never point this preset at another demo's API: catalogs require separate installations. Live pharmacy operation, regulated inventory and prescription workflows are outside this illustrative catalog.

### Pharmacy demo data and availability

The pharmacy preset includes 40 products across five brands and eight categories, illustrative USD prices, product images, English/Arabic catalog copy, and five structured attributes: brand, product type, care area, texture and collection. Brand, type, care area and texture support filtering; all five support product comparison and display. These are catalog classifications, not clinical recommendations or invented ingredient/safety claims.

The standard seed provisions a dedicated `demo-global` warehouse and global stock pool with 1,000 units per active product. `--complete` also provisions the same Egypt demo delivery-area workflow used by grocery, using the pharmacy inventory profile. Reruns backfill missing product attributes while retaining merchant edits and custom attribute-set assignments. Arabic attribute labels and options are seeded through the language API.

`--verify` checks the published theme, catalog images, required attribute definitions/values, and enabled global stock with positive unreserved quantities for every required product. It reports unavailable SKUs. The local read-only preview provides catalog browsing and attribute filters; it does not contain a live inventory database, checkout, customers or orders. Apply the complete seed to the isolated pharmacy backend to populate actual inventory records.
