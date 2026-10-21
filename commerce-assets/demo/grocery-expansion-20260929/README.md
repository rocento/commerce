# Grocery catalog expansion

This manifest groups the 15 previously added pack sizes with their original SKUs
under 15 configurable parent products, then adds 20 distinct grocery items to the
existing `grocery-*` categories. Both size SKUs retain their IDs and inventory.

From the repository root:

```bash
# Validate categories, SKU conflicts, family structure and image files.
bash commerce-ops/deploy/aws-deploy/update-grocery-catalog.sh

# Upload images, convert families and add missing products.
bash commerce-ops/deploy/aws-deploy/update-grocery-catalog.sh --apply
```

Use `--phase families` or `--phase products` to run only one phase. The old
`seed-grocery-extra.sh` command only concerns the previous 15 size SKUs; use the
new command for this expansion.

The launcher uploads a temporary bundle to EC2. The Python runner uses verified
origin HTTPS and server-side bootstrap credentials; credentials are not bundled.
Applying takes the deployment lock and saves product metadata under
`/var/log/rocento/catalog/` before changing it. API changes are not a single
transaction: rerun the command to resume an interrupted run. Existing new-product
SKUs are kept, and already assigned inventory (including sold-out stock) is not
reset. Missing source assignments receive 30 demo units per primary stock source.

The PNG images were generated individually using the built-in `image_gen` tool.
`prompts.json` records the exact prompt set. They are illustrative product photos,
not manufacturer packaging or ingredient claims. Prices follow the existing USD
demo catalog. The manifest records the full item names, prices and categories.
