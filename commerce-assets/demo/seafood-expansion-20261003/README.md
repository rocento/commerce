# Seven new seafood products

Adds seven distinct products to the existing production `grocery-fish-seafood`
category. Prices use the existing USD demo catalog convention. Each item has its
own generated illustrative photo, nine existing attribute values, description,
pack size, and 30 initial demo units at each primary enabled stock source.

`manifest.json` is the exact requested catalog payload. The runner is
`commerce-ops/scripts/add-seafood-products-20261003.py`; preview by default and `--apply` to
create. Run on the production server from `/opt/rocento`, passing the uploaded
asset directory with `--assets`. It uses existing server-side credentials,
verified origin HTTPS, the deployment lock, identity and option preflight checks,
a catalog snapshot, and public product/inventory verification. Reruns preserve
existing assigned inventory and reject conflicting product identities.

All PNGs were individually generated with the built-in imagegen tool and visually
reviewed. They are illustrative demo photography, with no manufacturer or origin
claims. Existing products are verified unchanged after creation.
