#!/usr/bin/env python3
"""Add reviewed jewelry designs, semantic attributes and optimized image derivatives.

Preview by default. Existing prices, inventory, product identity and media originals
are preserved. Uses the installation's admin APIs and deployment lock.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import fcntl
import hashlib
import importlib.util
import json
import os
import shlex
import socket
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# Reuse the tested, identity-preserving attribute planner and verification routine.
spec = importlib.util.spec_from_file_location(
    "attribute_seed",
    Path(__file__).with_name("seed-grocery-recommendation-attributes.py"),
)
attributes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(attributes)


def preflight(snapshot, manifest, assets):
    assert len(manifest["products"]) == 20, "Expected 20 new designs"
    assert len({p["sku"] for p in manifest["products"]}) == 20, "Duplicate SKU"
    assert len({p["slug"] for p in manifest["products"]}) == 20, "Duplicate slug"
    assert len({p["name"].casefold() for p in manifest["products"]}) == 20, (
        "Duplicate name"
    )
    assert all(
        p["sku"].startswith("DEMO-JWL-") or p["sku"].startswith("JWL-NEW-20260929-")
        for p in snapshot["products"]
    ), "Unexpected installation or catalog; inspect before applying"
    definitions = {
        d["attribute_code"]: {o["value"] for o in d["options"]}
        for d in manifest["definitions"]
    }
    color_definition = next(
        (d for d in snapshot["definitions"] if d["attribute_code"] == "color"), None
    )
    assert color_definition and color_definition["input_type"] == "text", (
        "Expected existing text color attribute"
    )
    categories = {c["slug"] for c in snapshot["categories"]}
    by_sku = {p["sku"]: p for p in snapshot["products"]}
    for p in manifest["products"]:
        assert p["category"] in categories, "Missing jewelry category"
        assert p["unit"] in {"each", "lb", "kg", "oz", "pack", "L"}, (
            "Unsupported sales unit"
        )
        assert (assets / p["image"]).is_file(), "Missing image: " + p["image"]
        assert (assets / p["image"]).stat().st_size <= 5 * 1024 * 1024, (
            "Image exceeds upload limit"
        )
        assert all(
            (isinstance(v, str) and 0 < len(v) <= 100)
            if k == "color"
            else (isinstance(v, list) and v and set(v) <= definitions[k])
            for k, v in p["attributes"].items()
        ), "Unknown attribute value"
        assert not any(
            old["sku"] != p["sku"]
            and (
                old["slug"] == p["slug"]
                or old["name"].casefold() == p["name"].casefold()
            )
            for old in snapshot["products"]
        ), "Existing design collision"
        if p["sku"] in by_sku:
            old = by_sku[p["sku"]]
            assert old["slug"] == p["slug"] and old["name"] == p["name"], (
                "Changed seeded identity"
            )
    existing_manifest = {
        "definitions": manifest["definitions"],
        "products": manifest["existing_products"],
    }
    definitions, changes, default_set = attributes.plan(
        snapshot, existing_manifest, group_name="Jewelry recommendations"
    )
    return existing_manifest, definitions, changes, default_set


def image_bytes(client, media_id, width=None):
    path = f"/v1/catalog/media/{media_id}/content" + (
        f"?width={width}" if width else ""
    )
    with client.http.open(
        urllib.request.Request(client.base + path, headers={"X-Commerce-Request": "1"}),
        timeout=60,
    ) as response:
        return response.read(), response.headers.get("Content-Type")


def expand(client, snapshot, manifest, assets, checkpoint):
    existing_manifest, _, _, _ = preflight(snapshot, manifest, assets)
    categories = {c["slug"]: c["id"] for c in snapshot["categories"]}
    by_sku = {p["sku"]: p for p in attributes.products(client)}
    enabled = {
        s["id"]
        for s in client.call("GET", "/v1/admin/inventory/sources")
        if s["is_enabled"]
    }
    stocks = client.call("GET", "/v1/admin/inventory/stocks")
    source_ids = {
        min(
            (s for s in stock["sources"] if s["source_id"] in enabled),
            key=lambda s: s["priority"],
        )["source_id"]
        for stock in stocks
        if any(s["source_id"] in enabled for s in stock["sources"])
    }
    assert source_ids, "No enabled fulfillment source"
    state = (
        json.loads(checkpoint.read_text())
        if checkpoint.exists()
        else {
            "uploads": {},
            "processed": {},
            "manifest_sha256": hashlib.sha256(
                (assets / "manifest.json").read_bytes()
            ).hexdigest(),
        }
    )
    assert (
        state["manifest_sha256"]
        == hashlib.sha256((assets / "manifest.json").read_bytes()).hexdigest()
    ), "Manifest changed since checkpoint"

    def save():
        checkpoint.write_text(json.dumps(state, indent=2))
        checkpoint.chmod(0o600)

    summary = attributes.apply(
        client, snapshot, existing_manifest, group_name="Jewelry recommendations"
    )
    created = 0
    for row in manifest["products"]:
        product = by_sku.get(row["sku"])
        if product is None:
            image_path = assets / row["image"]
            if row["sku"] not in state["uploads"]:
                media = client.upload(
                    image_path,
                    row["name"] + " — AI-generated illustrative jewelry design",
                )
                state["uploads"][row["sku"]] = media["id"]
                save()
            payload = {
                k: row[k]
                for k in (
                    "sku",
                    "slug",
                    "name",
                    "price",
                    "currency",
                    "unit",
                    "description",
                    "attributes",
                )
            }
            payload.update(
                category_id=categories[row["category"]],
                media_ids=[state["uploads"][row["sku"]]],
                active=True,
                in_stock=True,
            )
            product = client.call("POST", "/v1/admin/catalog/products", payload)
            created += 1
        missing = {
            k: v for k, v in row["attributes"].items() if k not in product["attributes"]
        }
        assert all(
            product["attributes"].get(k, v) == v for k, v in row["attributes"].items()
        ), "Seeded product attributes were edited"
        if missing:
            payload = {k: product[k] for k in attributes.FIELDS if k in product}
            payload["attributes"] = {**product["attributes"], **missing}
            client.call("PUT", "/v1/admin/catalog/products/" + product["id"], payload)
        endpoint = "/v1/admin/inventory/" + product["id"] + "/sources"
        inventory = {s["source_id"]: s for s in client.call("GET", endpoint)}
        assert all(
            s in inventory and "is_assigned" in inventory[s] for s in source_ids
        ), "Missing inventory assignment state"
        for source_id in sorted(source_ids):
            if not inventory[source_id]["is_assigned"]:
                client.call(
                    "PUT",
                    endpoint,
                    {
                        "source_id": source_id,
                        "quantity": row["initial_quantity"],
                        "status": "in_stock",
                        "notify_stock_qty": 5,
                        "reason": "Initial stock for new jewelry demo designs",
                    },
                )
        print("Ready:", row["name"], flush=True)
    all_products = attributes.products(client)
    media_ids = sorted({mid for p in all_products for mid in p["media_ids"]})
    for media_id in media_ids:
        if media_id in state["processed"]:
            continue
        original, _ = image_bytes(client, media_id)
        before = hashlib.sha256(original).hexdigest()
        client.call("POST", f"/v1/admin/catalog/media/{media_id}/publication")
        variants = {}
        for width in (480, 960):
            data, kind = image_bytes(client, media_id, width)
            assert (
                kind.startswith("image/webp")
                and data[:4] == b"RIFF"
                and data[8:12] == b"WEBP"
            ), "Invalid image derivative"
            variants[str(width)] = len(data)
        after, _ = image_bytes(client, media_id)
        assert hashlib.sha256(after).hexdigest() == before, "Original image changed"
        state["processed"][media_id] = {
            "original_bytes": len(original),
            "original_sha256": before,
            "variants": variants,
        }
        save()
        print(
            "Optimized image:", len(state["processed"]), "/", len(media_ids), flush=True
        )
    actual = {p["sku"]: p for p in attributes.products(client)}
    assert len(actual) == len(snapshot["products"]) + created, (
        "Unexpected product count"
    )
    for row in manifest["products"]:
        p = actual[row["sku"]]
        assert (
            p["active"] and p["media_ids"] and p["attributes"] == row["attributes"]
        ), "New product verification failed"
        public = client.call("GET", "/v1/catalog/products/" + p["id"])
        assert public["active"] and public["media_ids"], "Public product unavailable"
    summary.update(
        created_products=created,
        total_products=len(actual),
        active_products=sum(p["active"] for p in actual.values()),
        optimized_images=len(media_ids),
        image_bytes=state["processed"],
    )
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/opt/rocento"))
    parser.add_argument("--assets", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    manifest = json.loads((args.assets / "manifest.json").read_text())
    lock = (args.root / "deploy/ec2/setup.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    env = {}
    for line in (args.root / "deploy/ec2/bootstrap.env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            t = shlex.split(v, comments=True)
            env[k.strip()] = t[0] if t else ""
    host = "jewelry-admin." + env["DOMAIN"]
    resolve = socket.getaddrinfo
    socket.getaddrinfo = lambda hostname, port, *a, **kw: resolve(
        "127.0.0.1" if hostname == host else hostname, port, *a, **kw
    )
    os.environ["DEMO_SSL_CA_FILE"] = "/etc/nginx/ssl/rocento-origin.pem"
    sys.path.insert(0, str(args.root / "commerce-assets/demo"))
    from demo_seed import Client

    client = Client("https://" + host + "/api")
    client.call(
        "POST",
        "/v1/admin/auth/login",
        {
            "email": env["JEWELRY_ADMIN_EMAIL"],
            "password": env["JEWELRY_ADMIN_PASSWORD"],
        },
    )
    try:
        snapshot = {
            "products": attributes.products(client),
            "definitions": client.call(
                "GET", "/v1/admin/attribute-definitions?entity_type=product"
            ),
            "sets": client.call("GET", "/v1/admin/attribute-sets"),
            "categories": client.call("GET", "/v1/catalog/categories"),
        }
        _, defs, changes, _ = preflight(snapshot, manifest, args.assets)
        old_skus = {p["sku"] for p in snapshot["products"]}
        print(
            json.dumps(
                {
                    "new_products": sum(
                        p["sku"] not in old_skus for p in manifest["products"]
                    ),
                    "new_definitions": len(defs),
                    "existing_attribute_updates": len(changes),
                }
            ),
            flush=True,
        )
        if args.apply:
            directory = Path("/var/log/rocento/catalog")
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            backup = directory / (
                datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
                + "-jewelry-before.json"
            )
            with backup.open("x") as output:
                os.fchmod(output.fileno(), 0o600)
                json.dump(snapshot, output, indent=2)
            print("Backup:", backup, flush=True)
            result = expand(
                client,
                snapshot,
                manifest,
                args.assets,
                directory / "jewelry-expansion-20260929-checkpoint.json",
            )
            (directory / "jewelry-expansion-20260929-result.json").write_text(
                json.dumps(result, indent=2)
            )
            print(
                json.dumps({k: v for k, v in result.items() if k != "image_bytes"}),
                flush=True,
            )
    finally:
        client.call("POST", "/v1/admin/auth/logout")
        socket.getaddrinfo = resolve
        lock.close()


if __name__ == "__main__":
    main()
