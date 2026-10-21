#!/usr/bin/env python3
"""Build and apply catalog-backed assistant attributes through normal admin APIs.

Build writes a reviewable manifest from an admin catalog snapshot. Apply preserves
unrelated fields, checks for concurrent edits, backs up each store, and is idempotent.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import copy
import fcntl
import json
import os
import re
import shlex
import socket
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

STORES = ("grocery", "jewelry", "electronics", "pharmacy")
NAMESPACE = uuid.UUID("b1d51bf7-6afd-4398-b31e-014df38ad7f9")
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


def definition(
    store, code, label, kind="multiselect", role=None, policy="factual", unit=None
):
    return {
        "id": str(uuid.uuid5(NAMESPACE, store + "/" + code)),
        "entity_type": "product",
        "attribute_code": code,
        "label": label,
        "input_type": kind,
        "scope": "global",
        "is_required": False,
        "is_unique": False,
        "is_searchable": True,
        "is_filterable": True,
        "is_comparable": True,
        "is_visible_on_front": True,
        "used_for_promo_rules": True,
        "used_for_configurations": False,
        "swatch_type": "none",
        "options": [],
        "version": 0,
        "metadata": {
            "status": "active",
            "admin_visible": True,
            "ai_queryable": True,
            "ai_enrichable": False,
            "facetable": True,
            "sortable": False,
            "source_policy": policy,
            "semantic_role": role,
            "unit": unit,
            "min": 0 if kind in ("integer", "decimal") else None,
            "display_order": 0,
            "description": (
                "Merchant-authored suggested use based on the existing demo catalog; "
                "not a compatibility, safety, health or performance guarantee."
                if policy == "semantic"
                else "Structured value extracted from the existing demo product name or attributes; "
                "not independently certified product specifications."
            ),
        },
    }


SPECS = {
    "grocery": [
        (
            "grocery_use_case",
            "Suggested use",
            "multiselect",
            "intended_use",
            "semantic",
            None,
        ),
        ("food_form", "Food form", "multiselect", None, "factual", None),
        ("pack_weight_g", "Pack weight g", "integer", None, "factual", "g"),
        ("pack_count", "Pack count", "integer", None, "factual", None),
    ],
    "jewelry": [
        (
            "wearing_area",
            "Wearing area",
            "multiselect",
            "intended_use",
            "factual",
            None,
        ),
        ("styling_use", "Styling use", "multiselect", "intended_use", "semantic", None),
        ("length_cm", "Length cm", "decimal", None, "factual", "cm"),
        ("ring_size_us", "Ring size US", "integer", None, "factual", None),
    ],
    "electronics": [
        (
            "electronics_use_case",
            "Suggested use",
            "multiselect",
            "intended_use",
            "semantic",
            None,
        ),
        (
            "connectivity_features",
            "Connection features",
            "multiselect",
            None,
            "factual",
            None,
        ),
        ("storage_gb", "Storage GB", "integer", None, "factual", "GB"),
        ("ram_gb", "RAM GB", "integer", None, "factual", "GB"),
        ("screen_inches", "Screen inches", "decimal", None, "factual", "in"),
    ],
    "pharmacy": [
        (
            "routine_step",
            "Routine step",
            "multiselect",
            "intended_use",
            "semantic",
            None,
        ),
        ("catalog_spf", "Catalog SPF", "integer", None, "factual", None),
    ],
}
ROLE_UPDATES = {
    "grocery": {},
    "jewelry": {},
    "electronics": {"brand": "brand", "device_type": "classification"},
    "pharmacy": {"brand": "brand", "care-area": "intended_use"},
}


def additions(store, p):
    """Only explicit catalog facts and conservative, labeled merchandising uses."""
    a = p["attributes"]
    name = p["name"]
    text = name.casefold()
    out = {}
    if store == "grocery":
        groups = set(a.get("grocery_group", []))
        prep = set(a.get("preparation_method", []))
        dishes = set(a.get("dish_type", []))
        meals = set(a.get("meal_occasion", []))
        if not groups or "household" in groups:
            return {}
        uses = []
        if "no_cook" in prep and not groups & {"meat", "seafood", "eggs"}:
            if "snack" in meals:
                uses += ["quick_snacks", "picnic"]
            if "sandwiches" in dishes or "snack" in meals:
                uses += ["packed_lunch"]
            if groups & {"bakery", "nuts", "dried_fruit"}:
                uses += ["sharing"]
        if prep - {"no_cook"}:
            uses += ["home_cooking"]
        if uses:
            out["grocery_use_case"] = sorted(set(uses))
        forms = {
            "loaf": r"\b(?:loaf|bread)\b",
            "rolls": r"\b(?:rolls|buns|bagels|baguettes)\b",
            "fillets": r"\b(?:fillets|tenderloins)\b",
            "minced": r"\bmince\b",
            "cubed": r"\bcubes\b",
            "flakes": r"\bflakes\b",
            "powder": r"\b(?:powder|flour)\b",
            "sliced": r"\bsliced\b",
            "grated": r"\bgrated\b",
            "dried": r"\bdried\b",
            "paste": r"\bpaste\b",
            "whole": r"\bwhole (?:chicken|fish)\b",
        }
        matched = [v for v, pattern in forms.items() if re.search(pattern, text)]
        if matched:
            out["food_form"] = matched
        weight = re.search(r"\b(\d+(?:\.\d+)?)\s*(kg|g)\b", text)
        if weight:
            grams = float(weight[1]) * (1000 if weight[2] == "kg" else 1)
            if grams.is_integer():
                out["pack_weight_g"] = int(grams)
        count = re.search(r"\b(\d+)\s*pack\b", text)
        if count:
            out["pack_count"] = int(count[1])
    elif store == "jewelry":
        kinds = set(a.get("jewelry_type", []))
        styles = set(a.get("jewelry_style", []))
        area = {
            "necklace": "neck",
            "earring": "ears",
            "ring": "fingers",
            "bracelet": "wrists",
            "anklet": "ankles",
            "hair_accessory": "hair",
            "brooch": "lapel",
            "tie_clip": "tie",
            "cufflink": "shirt_cuffs",
        }
        areas = sorted({area[t] for t in kinds if t in area})
        if areas:
            out["wearing_area"] = areas
        uses = []
        if "minimalist" in styles:
            uses += ["minimalist_outfits"]
        if "statement" in styles:
            uses += ["statement_outfits"]
        if "nature" in styles:
            uses += ["nature_inspired_outfits"]
        if set(a.get("jewelry_occasion", [])) & {"wedding", "evening", "work"}:
            uses += ["formal_outfits"]
        if kinds & {"necklace", "bracelet"} and set(a.get("jewelry_design", [])) & {
            "chain",
            "rope_chain",
            "plain_band",
            "link",
        }:
            uses += ["layering"]
        if uses:
            out["styling_use"] = uses
        length = re.fullmatch(r"(\d+(?:\.\d+)?)cm", str(a.get("jewelry_length", "")))
        if length:
            out["length_cm"] = float(length[1])
        if "ring" in kinds and str(a.get("size", "")).isdigit():
            out["ring_size_us"] = int(a["size"])
    elif store == "electronics":
        kind = a.get("device_type", "").casefold()
        # Older demo rows omit the type but explicitly name their model family.
        if not kind:
            if "macbook" in text:
                kind = "laptop"
            elif any(
                v in text for v in ["iphone", "galaxy", "pixel", "oneplus", "mi 11"]
            ):
                kind = "smartphone"
        uses = []
        if kind in {"laptop", "desktop computer"}:
            uses = ["work", "study", "programming"]
        elif kind == "tablet":
            uses = ["study", "reading", "travel", "streaming"]
        elif kind == "smartphone":
            uses = ["communication", "travel"]
        elif "game console" in kind:
            uses = ["gaming"]
        elif kind == "mirrorless camera":
            uses = ["photography", "video_recording"]
        elif kind in {"wireless earbuds", "over-ear headphones"}:
            uses = ["music", "travel"]
        elif kind == "webcam":
            uses = ["video_calls", "work"]
        elif "keyboard" in kind or "mouse" in kind:
            uses = ["work", "study"]
        elif kind == "streaming media player":
            uses = ["streaming", "home_entertainment"]
        if uses:
            out["electronics_use_case"] = uses
        connection = a.get("connectivity", "").casefold()
        features = {
            "bluetooth": r"bluetooth",
            "wifi": r"wi-fi",
            "usb_c": r"usb-c",
            "usb_a": r"usb-a",
            "hdmi": r"hdmi",
            "ethernet": r"ethernet",
            "5g": r"\b5g\b",
            "thunderbolt": r"thunderbolt",
        }
        found = [v for v, pat in features.items() if re.search(pat, connection)]
        if found:
            out["connectivity_features"] = found
        for src, dst in [("storage", "storage_gb"), ("memory", "ram_gb")]:
            m = re.fullmatch(r"(\d+) (GB|TB)(?: SSD)?", a.get(src, ""))
            if m:
                out[dst] = int(m[1]) * (1000 if m[2] == "TB" else 1)
        display = re.match(r"(\d+(?:\.\d+)?)-inch", a.get("display", ""))
        if display:
            out["screen_inches"] = float(display[1])
    elif store == "pharmacy":
        kind = a.get("product-kind", "")
        area = a.get("care-area", "")
        steps = {
            "Cleanser": "cleansing",
            "Cleansing balm": "makeup_removal",
            "Essence": "essence_step",
            "Serum": "serum_step",
            "Moisturizer": "moisturizing",
            "Night cream": "night_care",
            "Eye cream": "eye_care",
            "Face mist": "face_refreshing",
            "Hand cream": "hand_care",
            "Lip care": "lip_care",
        }
        if kind in steps:
            out["routine_step"] = [steps[kind]]
        # Only the explicitly labeled SPF number, without suitability claims.
        spf = re.search(r"\bSPF\s+(\d+)\b", name)
        if spf:
            out["catalog_spf"] = int(spf[1])
    return out


def build(snapshots):
    result = {"version": 1, "stores": {}}
    for store in STORES:
        data = snapshots[store]
        rows = []
        for p in data["products"]:
            if not p["active"]:
                continue
            extra = additions(store, p)
            if extra:
                rows.append(
                    {
                        "id": p["id"],
                        "sku": p["sku"],
                        "name": p["name"],
                        "slug": p["slug"],
                        "attributes": extra,
                        "evidence": {"name": p["name"], "attributes": p["attributes"]},
                    }
                )
        defs = []
        for spec in SPECS[store]:
            d = definition(store, *spec)
            values = [
                r["attributes"][d["attribute_code"]]
                for r in rows
                if d["attribute_code"] in r["attributes"]
            ]
            if not values:
                continue
            if d["input_type"] == "multiselect":
                d["options"] = [
                    {"value": v, "label": v.replace("_", " ").capitalize()}
                    for v in sorted({v for row in values for v in row})
                ]
            defs.append(d)
        changes = []
        for code, role in ROLE_UPDATES[store].items():
            old = next(d for d in data["definitions"] if d["attribute_code"] == code)
            changes.append({"code": code, "id": old["id"], "semantic_role": role})
        result["stores"][store] = {
            "definitions": defs,
            "role_updates": changes,
            "products": rows,
        }
    return result


def compatible(old, want):
    for k, v in want.items():
        if k in ("version", "entity_id"):
            continue
        if k == "metadata":
            if any(old.get(k, {}).get(x) != y for x, y in v.items()):
                return False
        elif old.get(k) != v:
            return False
    return True


def plan(snapshot, manifest):
    existing = {d["attribute_code"]: d for d in snapshot["definitions"]}
    defs = []
    products = []
    sets = []
    for want in manifest["definitions"]:
        old = existing.get(want["attribute_code"])
        if old and not compatible(old, want):
            raise ValueError("Definition conflict: " + want["attribute_code"])
        if not old:
            defs.append((None, want))
    for change in manifest["role_updates"]:
        old = existing[change["code"]]
        if old["id"] != change["id"]:
            raise ValueError("Definition identity conflict")
        if old["metadata"].get("semantic_role") not in (None, change["semantic_role"]):
            raise ValueError("Role conflict")
        if old["metadata"].get("semantic_role") != change["semantic_role"]:
            new = copy.deepcopy(old)
            new["metadata"]["semantic_role"] = change["semantic_role"]
            defs.append((old, new))
    by_id = {p["id"]: p for p in snapshot["products"]}
    targets = set()
    for row in manifest["products"]:
        old = by_id[row["id"]]
        if (old["sku"], old["name"], old["slug"]) != (
            row["sku"],
            row["name"],
            row["slug"],
        ):
            raise ValueError("Product identity conflict")
        # The source facts supporting each assignment must still be unchanged.
        if any(
            old["attributes"].get(k) != v
            for k, v in row["evidence"]["attributes"].items()
        ):
            raise ValueError("Evidence changed: " + old["sku"])
        for k, v in row["attributes"].items():
            if k in old["attributes"] and old["attributes"][k] != v:
                raise ValueError("Attribute conflict: " + old["sku"] + "/" + k)
        targets.add(old.get("attribute_set_id"))
        if any(old["attributes"].get(k) != v for k, v in row["attributes"].items()):
            new = {k: copy.deepcopy(old[k]) for k in FIELDS if k in old}
            new["attributes"].update(row["attributes"])
            products.append((old, new))
    default = next(s["id"] for s in snapshot["sets"] if s["name"] == "Default")
    targets = {default if t is None else t for t in targets}
    for old in snapshot["sets"]:
        if old["id"] not in targets:
            continue
        new = copy.deepcopy(old)
        members = {m["definition_id"] for m in new["members"]}
        for n, d in enumerate(manifest["definitions"]):
            if d["id"] not in members:
                new["members"].append(
                    {
                        "definition_id": d["id"],
                        "group_name": "Assistant discovery",
                        "position": (n + 1) * 10,
                    }
                )
        if new != old:
            sets.append((old, new))
    return defs, sets, products


def snapshot(client):
    data = {
        k: client.call("GET", path)
        for k, path in {
            "definitions": "/v1/admin/attribute-definitions?entity_type=product",
            "sets": "/v1/admin/attribute-sets",
        }.items()
    }
    data["products"] = []
    while True:
        page = client.call(
            "GET", "/v1/admin/catalog/products?offset=" + str(len(data["products"]))
        )
        data["products"].extend(page)
        if len(page) < 50:
            return data


def apply(client, before, manifest):
    defs, sets, products = plan(before, manifest)
    for old, new in defs:
        if old:
            current = client.call(
                "GET", "/v1/admin/attribute-definitions?entity_type=product"
            )
            if next(d for d in current if d["id"] == old["id"]) != old:
                raise ValueError("Definition changed during apply")
        client.call("POST", "/v1/admin/attribute-definitions", new)
    for old, new in sets:
        current = client.call("GET", "/v1/admin/attribute-sets")
        if next(s for s in current if s["id"] == old["id"]) != old:
            raise ValueError("Set changed during apply")
        client.call("POST", "/v1/admin/attribute-sets", new)
    for old, new in products:
        current = client.call("GET", "/v1/admin/catalog/products/" + old["id"])
        if any(current.get(k) != old.get(k) for k in FIELDS):
            raise ValueError("Product changed during apply")
        client.call("PUT", "/v1/admin/catalog/products/" + old["id"], new)
    after = snapshot(client)
    assert plan(after, manifest) == ([], [], []), "Non-idempotent final state"
    by_id = {p["id"]: p for p in after["products"]}
    changes = {row["id"]: row["attributes"] for row in manifest["products"]}
    for old in before["products"]:
        new = by_id[old["id"]]
        assert all(
            new.get(k) == v
            for k, v in old.items()
            if k not in ("attributes", "updated_at")
        ), "Unrelated product change"
        assert new["attributes"] == {
            **old["attributes"],
            **changes.get(old["id"], {}),
        }, "Attribute preservation failure"
    return {
        "definitions_written": len(defs),
        "sets_updated": len(sets),
        "products_updated": len(products),
    }, after


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--build", type=Path)
    p.add_argument("--manifest", type=Path, required=True)
    p.add_argument("--root", type=Path, default=Path("/opt/rocento"))
    p.add_argument("--apply", action="store_true")
    args = p.parse_args()
    if args.build:
        args.manifest.parent.mkdir(parents=True, exist_ok=True)
        args.manifest.write_text(
            json.dumps(build(json.loads(args.build.read_text())), indent=2) + "\n"
        )
        return
    manifest = json.loads(args.manifest.read_text())
    values = {}
    for line in (args.root / "deploy/ec2/bootstrap.env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            tokens = shlex.split(v, comments=True)
            values[k.strip()] = tokens[0] if tokens else ""
    os.environ["DEMO_SSL_CA_FILE"] = "/etc/nginx/ssl/rocento-origin.pem"
    sys.path.insert(0, str(args.root / "commerce-assets/demo"))
    from demo_seed import Client

    resolve = socket.getaddrinfo
    lock = (args.root / "deploy/ec2/setup.lock").open("a")
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    clients = {}
    before = {}
    try:
        hosts = {
            s: ("admin" if s == "grocery" else s + "-admin") + "." + values["DOMAIN"]
            for s in STORES
        }
        socket.getaddrinfo = lambda hostname, port, *a, **kw: resolve(
            "127.0.0.1" if hostname in hosts.values() else hostname, port, *a, **kw
        )
        for store, host in hosts.items():
            c = Client("https://" + host + "/api")
            c.call(
                "POST",
                "/v1/admin/auth/login",
                {
                    "email": values[store.upper() + "_ADMIN_EMAIL"],
                    "password": values[store.upper() + "_ADMIN_PASSWORD"],
                },
            )
            clients[store] = c
            before[store] = snapshot(c)
        # Preflight every store before any catalog mutation.
        for store in STORES:
            defs, sets, products = plan(before[store], manifest["stores"][store])
            print(
                json.dumps(
                    {
                        "store": store,
                        "planned_definitions": len(defs),
                        "planned_sets": len(sets),
                        "planned_products": len(products),
                    }
                ),
                flush=True,
            )
        if not args.apply:
            return
        backup = Path("/var/log/rocento/catalog") / (
            "advanced-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        )
        backup.mkdir(parents=True, mode=0o700)
        for store in STORES:
            (backup / (store + "-before.json")).write_text(
                json.dumps(before[store], indent=2)
            )
        print("Backup: " + str(backup), flush=True)
        for store in STORES:
            report, after = apply(
                clients[store], before[store], manifest["stores"][store]
            )
            (backup / (store + "-after.json")).write_text(json.dumps(after, indent=2))
            print(json.dumps(dict(store=store, **report)), flush=True)
        print("All stores verified; catalog changes only.", flush=True)
    finally:
        for c in clients.values():
            c.call("POST", "/v1/admin/auth/logout")
        socket.getaddrinfo = resolve
        lock.close()


if __name__ == "__main__":
    main()
