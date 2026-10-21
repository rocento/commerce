# New-client catalog data installation

Each client gets an independent deployment/database. The installer targets only the `DATABASE_URL` supplied to its process (the selected Compose project's gateway environment). Run these commands separately for every client; sales channels do not isolate different clients' catalogs.

## What every installation includes

| Package | Contents | Installation mechanism |
| --- | --- | --- |
| Core commerce | Core product fields (SKU, name, price, currency, status, media references, categories and inventory integration), attribute infrastructure, administrator roles/permissions, default warehouse/stock and storefront stock link, baseline fulfillment settings | Versioned database migrations, automatically run at gateway startup or explicitly with `--install-core --apply` |
| Industry catalog | Recommended typed attribute definitions, stable option codes/labels, validation and source policies, attribute groups, a default attribute set, selected industry configuration | Explicitly install the selected built-in or merchant-created industry profile |
| Merchant configuration | Product data, categories, inventory quantities, credentials, applicable tax/delivery rules and branding | Configure/import for that client through existing tools and Admin |

Fundamental product fields remain native fields. The installer does not duplicate them as dynamic attributes. Demo merchandise and theme publishing are separate from client onboarding. Review the platform's initial currency/fulfillment defaults for each client before launch.

## Standard onboarding commands

The gateway image includes `install-catalog-data`. First build/start the client's own Compose deployment using its own project name, environment and volumes. Use the same Compose flags for all commands below; replace `CLIENT` with that deployment's actual project name. Add its `-f` and `--env-file` flags where applicable.

```sh
# Inspect shipped industry packages without a database connection.
docker compose -p CLIENT exec -T api-gateway install-catalog-data --list

# Install core schema/baseline data. Already-applied migrations are skipped.
# Gateway startup normally has already performed this step.
docker compose -p CLIENT exec -T api-gateway install-catalog-data --install-core --apply

# Preview the client's proposed industry definitions, options, groups and conflicts.
docker compose -p CLIENT exec -T api-gateway install-catalog-data --industry jewelry

# Explicitly confirm installation of the previewed package.
docker compose -p CLIENT exec -T api-gateway install-catalog-data --industry jewelry --apply
```

Use `general` when no specialist starter fields are needed. Built-in packages currently include general, fashion, jewelry, skincare, pharmacy, electronics, beauty, grocery and home. `--list` discovers the shipped packages; custom profile codes created in Admin are also accepted by `--industry`.

For a provisioning pipeline where the client has already chosen/approved the package:

```sh
docker compose -p CLIENT exec -T api-gateway install-catalog-data \
  --install-core --industry jewelry --apply
```

The same binary also runs outside Docker using the target client's `DATABASE_URL`. Do not put connection credentials in command-line arguments or onboarding reports. The command exits nonzero on migration errors, conflicting definitions, unknown industries, stale concurrent configuration or an attempted industry switch.

Bootstrap the first administrator using the existing `seed-admin` command in that same client deployment. Prefer `BOOTSTRAP_ADMIN_PASSWORD` from the deployment's secret mechanism. The local `commerce-ops/scripts/bootstrap-admin.py` convenience wrapper targets the default local Compose project; do not use it unchanged for a different client's deployment.

## Reruns, customization and upgrades

- Repeating installation for an already selected industry preserves merchant labels, options, disabled attributes and customized sets. It does not reset them to the template or change the configuration version.
- A different selected industry causes onboarding to stop. Use **Settings → Catalog → Industry profile** to preview, customize and explicitly confirm a change.
- On a first install, incompatible existing definitions cause the underlying atomic profile application to fail. Resolve those conflicts in Admin instead of overwriting catalog data.
- Compatible definitions are reused. New definitions/options/groups/default set are installed atomically; existing product values and assignments are preserved.
- New products in Admin initially select the installed default attribute set. Merchants can choose another set. Existing product edits retain their assigned set.
- Template upgrades are intentionally not reapplied by provisioning reruns. Review changes through the Admin flow; automatic destructive template synchronization is not supported.
- Industry selection does not select or alter themes. No AI enrichment model is automatically enabled. Pharmacy factual attributes retain trusted-only source policies.

## Verification

The catalog integration suite boots fresh migrated databases for every shipped industry and checks installed definitions/options/groups/default set, core inventory defaults, absence of demo products, safe repeat installation after merchant customization and refusal to switch industries during onboarding. CLI tests check explicit write flags and invalid argument rejection.

After onboarding, verify the selected profile in Admin and create a product to inspect its grouped attributes. The existing durable search worker indexes attribute changes; allow its backlog to finish before checking storefront/assistant filtering.

### Recorded checks

- 15 catalog integration tests passed, including fresh-client installation for all 9 built-in packages.
- CLI argument safety test passed; Admin TypeScript check passed.
- Actual installer smoke on an empty disposable PostgreSQL database passed: core + Jewelry install produced 15 definitions, one default set and no products; preview was read-only; a complete repeat run produced an identical database snapshot; a different-industry attempt failed without changing that snapshot.
- The packaged Dockerfile copies the new binary; a full Docker image rebuild was not run in this verification. Rebuild the gateway image before using it in a deployment.
