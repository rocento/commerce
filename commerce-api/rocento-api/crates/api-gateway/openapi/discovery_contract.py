"""M07 additive discovery contracts, independently versioned from agent core."""


def extend(schemas, endpoint, paths):
    S = lambda maximum=200: {"type": "string", "maxLength": maximum}
    U = lambda: {"type": "string", "format": "uuid"}
    T = lambda: {"type": "string", "format": "date-time"}
    B = lambda: {"type": "boolean"}
    I = lambda maximum=100000: {"type": "integer", "minimum": 0, "maximum": maximum}
    ref = lambda n: {"$ref": "#/components/schemas/" + n}
    null = lambda v: {**v, "nullable": True}
    enum = lambda *v: {"type": "string", "enum": list(v)}
    arr = lambda v, n: {"type": "array", "items": v, "maxItems": n}
    obj = lambda p, optional=(): {
        "type": "object",
        "properties": p,
        "required": [k for k in p if k not in optional],
        "additionalProperties": False,
    }
    relation = enum(
        "belongs_to",
        "variant_of",
        "compatible_with",
        "incompatible_with",
        "substitutes",
        "complements",
        "required_accessory",
        "used_for",
        "occasion",
        "contains",
        "excludes",
        "selling_unit",
        "policy_restriction",
        "synonym",
    )
    edge = {
        "product_id": U(),
        "relation": relation,
        "target_product_id": null(U()),
        "value": {**S(160), "minLength": 1},
        "dimensions": {
            "type": "object",
            "additionalProperties": S(160),
            "maxProperties": 10,
        },
        "source": enum("merchant", "imported", "generated"),
        "reviewed": B(),
        "expires_at": T(),
    }
    schemas["DiscoveryEdgeInput"] = obj(edge)
    schemas["DiscoveryEdge"] = obj({"id": U(), **edge, "updated_at": T()})
    schemas["DiscoveryOffer"] = obj(
        {
            "product_id": U(),
            "parent_id": null(U()),
            "category_id": U(),
            "price": {"type": "string", "pattern": r"^\d{1,12}(\.\d{1,6})?$"},
            "currency": {"type": "string", "minLength": 3, "maxLength": 3},
            "selling_unit": S(100),
            "in_stock": null(B()),
            "observed_at": T(),
            "expires_at": T(),
        }
    )
    schemas["DiscoveryContribution"] = obj(
        {
            "code": {**S(64), "pattern": "^[a-z_]+$", "minLength": 1},
            "points": {"type": "integer", "minimum": -10000, "maximum": 10000},
        }
    )
    schemas["DiscoveryProjection"] = obj(
        {
            "schema_version": enum("1.0.0"),
            "rank": {**I(8), "minimum": 1},
            "score": {"type": "integer", "minimum": -100000, "maximum": 100000},
            "contributions": arr(ref("DiscoveryContribution"), 10),
            "sponsored": B(),
            "merchant_boost": I(10),
            "offer": ref("DiscoveryOffer"),
            "relationships": arr(ref("DiscoveryEdge"), 10),
        }
    )
    schemas["DiscoveryReport"] = obj(
        {
            "schema_version": enum("1.0.0"),
            "retrieval": S(),
            "ranker": S(),
            "lexical_candidates": I(20),
            "relation_candidates": I(20),
            "evaluated": I(40),
            "eligible": I(40),
            "returned": I(8),
            "exhaustive": {"type": "boolean", "enum": [False]},
            "semantic_enabled": {"type": "boolean", "enum": [False]},
            "outcome": enum(
                "bounded_no_candidates",
                "current_facts_filtered",
                "availability_unknown",
                "matches",
            ),
        }
    )
    schemas["ShopperProduct"]["properties"]["discovery"] = null(
        ref("DiscoveryProjection")
    )
    schemas["ShopperCatalogResult"]["properties"]["discovery"] = null(
        ref("DiscoveryReport")
    )
    schemas["DiscoveryCoverageCategory"] = obj(
        {
            "category_id": U(),
            "category_name": S(1000),
            **{
                k: I(10000000)
                for k in [
                    "products",
                    "expected_values",
                    "present_values",
                    "factual_values",
                    "fresh_values",
                    "invalid_values",
                    "confidence_known",
                ]
            },
            "mean_confidence": null({"type": "number", "minimum": 0, "maximum": 1}),
            "missing": {"type": "object", "additionalProperties": I(5000)},
        }
    )
    schemas["DiscoveryRankObservation"] = obj(
        {
            "product_id": U(),
            "name": S(1000),
            "ranker": S(),
            "rank": I(8),
            "score": {"type": "integer", "minimum": -100000, "maximum": 100000},
            "contributions": arr(ref("DiscoveryContribution"), 10),
            "sponsored": B(),
            "merchant_boost": I(10),
            "observed_at": T(),
        }
    )
    schemas["DiscoveryCoverage"] = obj(
        {
            "schema_version": enum("1.0.0"),
            "enabled": B(),
            "semantic_enabled": {"type": "boolean", "enum": [False]},
            "bounded": B(),
            "products_evaluated": I(5000),
            "attribute_scope": S(),
            "freshness_days": I(30),
            "pending_relationships": I(),
            "categories": arr(ref("DiscoveryCoverageCategory"), 5000),
            "rankings": arr(ref("DiscoveryRankObservation"), 20),
        }
    )
    schemas["DiscoveryConfiguration"] = obj({"enabled": B()})
    schemas["DiscoveryMerchandising"] = obj(
        {"product_id": U(), "boost": I(10), "sponsored": B(), "expires_at": T()}
    )
    endpoint(
        "/v1/admin/catalog/discovery", "get", "DiscoveryCoverage", auth="adminSession"
    )
    endpoint(
        "/v1/admin/catalog/discovery",
        "put",
        "DiscoveryConfiguration",
        "DiscoveryConfiguration",
        auth="adminSession",
    )
    endpoint(
        "/v1/admin/catalog/discovery/relationships",
        "post",
        "DiscoveryEdge",
        "DiscoveryEdgeInput",
        auth="adminSession",
    )
    endpoint(
        "/v1/admin/catalog/discovery/relationships/{id}",
        "delete",
        "Status",
        auth="adminSession",
    )
    endpoint(
        "/v1/admin/catalog/discovery/merchandising",
        "put",
        "Status",
        "DiscoveryMerchandising",
        auth="adminSession",
    )
