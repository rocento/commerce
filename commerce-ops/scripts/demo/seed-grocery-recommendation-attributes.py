#!/usr/bin/env python3
"""Preview/apply reviewed catalog attributes through admin APIs; never activate products."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import fcntl
import json
import os
import shlex
import socket
import sys
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

FIELDS = (
    "sku",
    "slug",
    "name",
    "price",
    "currency",
    "unit",
    "description",
    "category_id",
    "media_ids",
    "active",
    "in_stock",
    "attributes",
    "attribute_set_id",
)


def products(client):
    result = []
    while True:
        page = client.call("GET", f"/v1/admin/catalog/products?offset={len(result)}")
        result.extend(page)
        if len(page) < 50:
            return result


def plan(snapshot, manifest, *, group_name="Grocery recommendations"):
    definitions = {d["attribute_code"]: d for d in snapshot["definitions"]}
    by_sku = {p["sku"]: p for p in snapshot["products"]}
    expected = {d["attribute_code"]: d for d in manifest["definitions"]}
    if len(expected) != len(manifest["definitions"]) or len(
        {p["sku"] for p in manifest["products"]}
    ) != len(manifest["products"]):
        raise ValueError("Duplicate manifest identity")
    new_definitions = []
    for code, definition in expected.items():
        old = definitions.get(code)
        if old:
            for key, value in definition.items():
                if key == "version":
                    continue
                actual = old.get(key)
                if key == "metadata":
                    actual = {k: actual.get(k) for k in value}
                if actual != value:
                    raise ValueError("Existing definition conflict: " + code)
        else:
            new_definitions.append(definition)
    changed = []
    for row in manifest["products"]:
        old = by_sku.get(row["sku"])
        if not old or (old["name"], old["slug"]) != (row["name"], row["slug"]):
            raise ValueError("Product identity conflict: " + row["sku"])
        if old.get("attribute_set_id") is not None:
            raise ValueError("Unexpected custom attribute set: " + row["sku"])
        for code, value in row["attributes"].items():
            allowed = {o["value"] for o in expected[code]["options"]}
            kind = expected[code]["input_type"]
            valid = (
                isinstance(value, str) and value in allowed
                if kind in {"select", "single_select"}
                else kind in {"multi_select", "multiselect"}
                and isinstance(value, list)
                and bool(value)
                and all(isinstance(v, str) and v in allowed for v in value)
            )
            if not valid:
                raise ValueError("Invalid manifest value: " + row["sku"])
            if code in old["attributes"] and old["attributes"][code] != value:
                raise ValueError(
                    "Existing product attribute conflict: " + row["sku"] + "/" + code
                )
        if any(old["attributes"].get(k) != v for k, v in row["attributes"].items()):
            payload = {key: deepcopy(old[key]) for key in FIELDS if key in old}
            payload["attributes"].update(row["attributes"])
            changed.append((old, payload))
    defaults = [s for s in snapshot["sets"] if s["name"] == "Default"]
    if len(defaults) != 1:
        raise ValueError("Expected one default attribute set")
    attribute_set = deepcopy(defaults[0])
    members = {m["definition_id"] for m in attribute_set["members"]}
    position = max(
        (
            m["position"]
            for m in attribute_set["members"]
            if m["group_name"] == group_name
        ),
        default=0,
    )
    for definition in manifest["definitions"]:
        if definition["id"] not in members:
            position += 10
            attribute_set["members"].append(
                {
                    "definition_id": definition["id"],
                    "group_name": group_name,
                    "position": position,
                }
            )
    return (
        new_definitions,
        changed,
        attribute_set if attribute_set != defaults[0] else None,
    )


def apply(client, snapshot, manifest, *, group_name="Grocery recommendations"):
    definitions, changes, attribute_set = plan(
        snapshot, manifest, group_name=group_name
    )
    for definition in definitions:
        client.call("POST", "/v1/admin/attribute-definitions", definition)
    if attribute_set:
        client.call("POST", "/v1/admin/attribute-sets", attribute_set)
    for old, payload in changes:
        # Detect edits made since preflight before sending a full product DTO.
        current = client.call("GET", "/v1/admin/catalog/products/" + old["id"])
        if any(current.get(k) != old.get(k) for k in FIELDS):
            raise ValueError("Product changed during apply: " + old["sku"])
        client.call("PUT", "/v1/admin/catalog/products/" + old["id"], payload)
    after = products(client)
    by_id = {p["id"]: p for p in after}
    expected = {p["sku"]: p["attributes"] for p in manifest["products"]}
    for old in snapshot["products"]:
        actual = by_id[old["id"]]
        for key in old:
            if key not in ("attributes", "updated_at") and actual.get(key) != old[key]:
                raise ValueError("Unexpected product change: " + old["sku"] + "/" + key)
        if actual["attributes"] != {
            **old["attributes"],
            **expected.get(old["sku"], {}),
        }:
            raise ValueError("Attribute verification failed: " + old["sku"])
    return {
        "created_definitions": len(definitions),
        "updated_products": len(changes),
        "verified_products": len(expected),
        "active_products": sum(p["active"] for p in after),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("/opt/rocento"))
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--store", choices=("grocery", "jewelry"), default="grocery")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    lock = (args.root / "deploy/ec2/setup.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    values = {}
    for line in (args.root / "deploy/ec2/bootstrap.env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            tokens = shlex.split(value, comments=True)
            values[key.strip()] = tokens[0] if tokens else ""
    host = ("jewelry-admin." if args.store == "jewelry" else "admin.") + values[
        "DOMAIN"
    ]
    group_name = args.store.title() + " recommendations"
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
            "email": values[args.store.upper() + "_ADMIN_EMAIL"],
            "password": values[args.store.upper() + "_ADMIN_PASSWORD"],
        },
    )
    try:
        snapshot = {
            "products": products(client),
            "definitions": client.call(
                "GET", "/v1/admin/attribute-definitions?entity_type=product"
            ),
            "sets": client.call("GET", "/v1/admin/attribute-sets"),
        }
        definitions, changes, attribute_set = plan(
            snapshot, manifest, group_name=group_name
        )
        print(
            json.dumps(
                {
                    "planned_definitions": len(definitions),
                    "planned_products": len(changes),
                    "update_default_set": bool(attribute_set),
                }
            ),
            flush=True,
        )
        if args.apply:
            directory = Path("/var/log/rocento/catalog")
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            backup = directory / (
                datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
                + "-recommendation-attributes-before.json"
            )
            with backup.open("x") as output:
                os.fchmod(output.fileno(), 0o600)
                json.dump(snapshot, output, indent=2)
            print("Backup:", backup, flush=True)
            print(json.dumps(apply(client, snapshot, manifest, group_name=group_name)))
    finally:
        client.call("POST", "/v1/admin/auth/logout")
        socket.getaddrinfo = resolve
        lock.close()


if __name__ == "__main__":
    main()
