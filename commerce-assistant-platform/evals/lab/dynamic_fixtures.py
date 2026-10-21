"""Generate scoped acceptance cases from factual snapshots and their schemas.

Generation is data driven; no industry-specific field names, product claims,
or luxury/health/performance assumptions are added. These cases measure
declared factual invariants. Subjective answer quality requires human review.
"""

import json
from decimal import Decimal
from uuid import NAMESPACE_URL, uuid5

from evals.lab.catalog_oracle import (
    attribute_type,
    decoded,
    eligible_products,
    scalar_key,
)
from evals.lab.models import Case, Dataset, Expectation, Predicate, Snapshot


def generate(snapshots: list[Snapshot], revision="schema-discovery-v1") -> Dataset:
    cases = []

    def add(
        snapshot,
        suffix,
        message,
        output,
        expectation,
        *,
        suite="catalog_grounded",
        turns=None,
    ):
        expected = Expectation.model_validate(expectation)
        # Replay candidate membership is an oracle fixture, not measured search
        # recall. Keep the complete snapshot independent of this bounded page.
        eligible = eligible_products(snapshot, expected)
        eligible_ids = {str(p.id) for p in eligible}
        # Include valid and deliberately overbroad retrieval candidates. Giving
        # the runtime only oracle-approved results would let dropped constraints
        # appear to pass without exercising independent final validation.
        page = (
            eligible[:1]
            + [p for p in snapshot.products if str(p.id) not in eligible_ids][:4]
        )
        page += [p for p in eligible[1:] if p not in page][: 5 - len(page)]
        candidates = [str(p.id) for p in page[:5]]
        cases.append(
            Case.model_validate(
                {
                    "id": snapshot.id + "-" + suffix,
                    "snapshot": snapshot.id,
                    "store": snapshot.store,
                    "language": "en",
                    "journey": "discovery",
                    "kind": "catalog",
                    "suite": suite,
                    "candidates": candidates,
                    "turns": turns
                    or [
                        {
                            "message": message,
                            "model_output": {"shopping": True, **output},
                            "expected": expectation,
                        }
                    ],
                }
            )
        )

    for snapshot in snapshots:
        if not snapshot.catalog_complete:
            raise ValueError(
                "Dynamic acceptance generation requires an explicitly complete frozen snapshot"
            )
        categories = {}
        for product in snapshot.products:
            if product.product_type.casefold() in {"simple", "variant"}:
                categories.setdefault(str(product.category_id), []).append(product)
        for category_index, (category_id, products) in enumerate(
            sorted(categories.items()), 1
        ):
            noun = products[0].category_name or products[0].name
            common = {
                "category_ids": [category_id],
                "min_results": 1,
                "require_eligible": True,
            }
            output = {"query": "*", "category": noun}
            add(snapshot, f"category-{category_index}", f"Find {noun}", output, common)
            add(
                snapshot,
                f"recommend-{category_index}",
                f"Recommend {noun}",
                {**output, "presentation": "recommend"},
                common,
            )
            # The broad subjective target must remain useful. Clarifying is also
            # valid; the full-flow suite supplies that disjunctive oracle.
            add(
                snapshot,
                f"subjective-{category_index}",
                f"I need good {noun}",
                output,
                {
                    "category_ids": [category_id],
                    "text_none": ["guaranteed best"],
                    "require_eligible": True,
                    "allow_clarification": True,
                },
                suite="conversation",
            )
            currencies = sorted({p.currency for p in products})
            for currency_index, currency in enumerate(currencies, 1):
                prices = sorted(
                    {Decimal(p.price) for p in products if p.currency == currency}
                )
                upper = str(prices[-1])
                expected = {
                    **common,
                    "currency": currency,
                    "max_price": upper,
                    "exclusive_max": True,
                }
                if eligible_products(snapshot, Expectation.model_validate(expected)):
                    add(
                        snapshot,
                        f"budget-{category_index}-{currency_index}",
                        f"Find {noun} under {upper} {currency}",
                        {
                            **output,
                            "max_price": upper,
                            "exclusive_max": True,
                            "currency": currency,
                        },
                        expected,
                    )
            for attribute_index, attribute in enumerate(
                snapshot.catalog_schema.attributes, 1
            ):
                kind = attribute_type(attribute)
                if not attribute.filterable or kind not in {
                    "select",
                    "multiselect",
                    "boolean",
                    "integer",
                    "decimal",
                    "number",
                    "text",
                }:
                    continue
                observations = {}
                for product in products:
                    for fact in product.attributes:
                        if fact.name != attribute.code or fact.source not in {
                            "MERCHANT",
                            "VERIFIED",
                            "IMPORTED",
                        }:
                            continue
                        raw = decoded(fact.value)
                        values = (
                            raw
                            if kind == "multiselect" and isinstance(raw, list)
                            else [raw]
                        )
                        for value in values:
                            if isinstance(value, Decimal):
                                number = float(value)
                                if Decimal(str(number)) != value:
                                    continue
                                value = number
                            if isinstance(value, (str, int, float, bool)):
                                observations[scalar_key(value)] = value
                if not observations:
                    continue
                value = observations[min(observations, key=str)]
                predicate = Predicate(
                    code=attribute.code,
                    operator="contains" if kind == "multiselect" else "eq",
                    value=value,
                )
                expectation = {
                    **common,
                    "predicates": [predicate.model_dump(mode="json")],
                }
                if not eligible_products(
                    snapshot, Expectation.model_validate(expectation)
                ):
                    continue
                option = next(
                    (
                        o
                        for o in attribute.options
                        if scalar_key(o.code) == scalar_key(value)
                    ),
                    None,
                )
                label = option.label if option else str(value)
                add(
                    snapshot,
                    f"attribute-{category_index}-{attribute_index}",
                    f"Find {noun} with {attribute.label} {label}",
                    {
                        **output,
                        "attributes": [
                            {
                                "name": attribute.code,
                                "value": str(value).lower()
                                if isinstance(value, bool)
                                else str(value),
                            }
                        ],
                    },
                    expectation,
                )
                if kind in {
                    "integer",
                    "decimal",
                    "number",
                } and not isinstance(value, bool):
                    predicate = Predicate(
                        code=attribute.code, operator="gte", value=value
                    )
                    # Numeric range extraction is evaluated independently from
                    # exact numeric values; no text comparison is accepted.
                    add(
                        snapshot,
                        f"numeric-{category_index}-{attribute_index}",
                        f"Find {noun} with {attribute.label} at least {value}",
                        {
                            **output,
                            "attributes": [
                                {
                                    "name": attribute.code,
                                    "operator": "gte",
                                    "value": str(value),
                                }
                            ],
                        },
                        {**common, "predicates": [predicate.model_dump(mode="json")]},
                    )
                if len(observations) > 1:
                    excluded = Predicate(
                        code=attribute.code, operator="neq", value=value
                    )
                    expected = {
                        **common,
                        "predicates": [excluded.model_dump(mode="json")],
                    }
                    if eligible_products(
                        snapshot, Expectation.model_validate(expected)
                    ):
                        add(
                            snapshot,
                            f"exclude-{category_index}-{attribute_index}",
                            f"Find {noun} without {attribute.label} {label}",
                            {
                                **output,
                                "attributes": [
                                    {
                                        "name": attribute.code,
                                        "operator": "neq",
                                        "value": str(value).lower()
                                        if isinstance(value, bool)
                                        else str(value),
                                    }
                                ],
                            },
                            expected,
                        )
    return Dataset(revision=revision, snapshots=snapshots, cases=cases)


def historical_demo_snapshots(before, manifest, source_revision, observed_at):
    """Project an explicit historical capture plus reviewed applied manifest.

    Only existing product IDs are updated. All factual values retain merchant
    provenance; this is not a fresh live catalog or an isolated live canary.
    """
    snapshots = []
    for store, source in sorted(before.items()):
        changes = manifest["stores"].get(store, {})
        definitions = {d["attribute_code"]: d for d in source["definitions"]}
        definitions.update(
            {d["attribute_code"]: d for d in changes.get("definitions", [])}
        )
        roles = {d["code"]: d["semantic_role"] for d in changes.get("role_updates", [])}
        schema_attributes = []
        for code, definition in sorted(definitions.items()):
            metadata = definition.get("metadata", {})
            if metadata.get("status") != "active" or not metadata.get("ai_queryable"):
                continue
            schema_attributes.append(
                {
                    "code": code,
                    "label": definition["label"],
                    "data_type": definition["input_type"],
                    "options": [
                        {
                            "code": str(o["value"]),
                            "label": o["label"],
                            "labels": o.get("labels", {}),
                        }
                        for o in definition.get("options", [])
                    ],
                    "filterable": definition.get("is_filterable", False),
                    "searchable": definition.get("is_searchable", False),
                    "facetable": metadata.get("facetable", False),
                    "sortable": metadata.get("sortable", False),
                    "comparable": definition.get("is_comparable", False),
                    "variant_axis": definition.get("used_for_configurations", False),
                    "source_policy": metadata.get("source_policy", "factual"),
                    "semantic_role": roles.get(code, metadata.get("semantic_role")),
                    "description": metadata.get("description", ""),
                    "unit": metadata.get("unit"),
                    "min": metadata.get("min"),
                    "max": metadata.get("max"),
                }
            )
        known_codes = {a["code"] for a in schema_attributes}
        updates = {p["id"]: p["attributes"] for p in changes.get("products", [])}
        categories = {c["id"]: c["name"] for c in source["categories"]}
        products = []
        for product in source["products"]:
            if not product.get("active"):
                continue
            values = {**product.get("attributes", {}), **updates.get(product["id"], {})}
            products.append(
                {
                    "id": product["id"],
                    "name": product["name"],
                    "sku": product.get("sku", ""),
                    "price": product["price"],
                    "currency": product["currency"],
                    "category_id": product["category_id"],
                    "category_name": categories.get(product["category_id"], ""),
                    "product_type": product["product_type"],
                    "attributes": [
                        {
                            "name": k,
                            "value": json.dumps(v, ensure_ascii=False),
                            "source": "MERCHANT",
                        }
                        for k, v in sorted(values.items())
                        if k in known_codes
                    ],
                    "in_stock": product.get("in_stock"),
                    "route": "/products/" + product["id"],
                }
            )
        snapshots.append(
            Snapshot.model_validate(
                {
                    "id": store + "-historical-discovery",
                    "store": store,
                    "tenant_id": str(uuid5(NAMESPACE_URL, "rocento-eval:" + store)),
                    "source": "historical_demo_snapshot",
                    "source_revision": source_revision,
                    "observed_at": observed_at,
                    "catalog_complete": True,
                    "catalog_schema": {
                        "industry": store,
                        "version": source_revision,
                        "attributes": schema_attributes,
                        "categories": [
                            {
                                "id": c["id"],
                                "name": c["name"],
                                "parent_id": c.get("parent_id"),
                                "aliases": [],
                                "sellable_count": sum(
                                    p["category_id"] == c["id"]
                                    and p["product_type"] in {"simple", "variant"}
                                    for p in products
                                ),
                            }
                            for c in source["categories"]
                        ],
                    },
                    "products": products,
                    "category_memberships": {
                        p["id"]: p.get("category_ids", [p["category_id"]])
                        for p in source["products"]
                        if p.get("active")
                    },
                }
            )
        )
    return snapshots
