# Demo data

These scripts seed demo catalogs, delivery areas, recommendations, and storefront settings. Helpers such as `catalog_support.py` and `local_database.py` are shared by the entry scripts. Historical one-time imports are under `history/`.

Start with the [demo seeding task](../../tasks/demo-seeding.md). Check each command's target database or API and preview mode before applying changes. `seed-demo-storefront.py` requires `--apply` and an explicit `--api-base` to write storefront changes. The [production seed launcher](../../cloud/providers/aws/README.md) is maintained under `cloud/providers/aws/`.
