"""Authenticated customer activity and cursor-paginated admin journey."""


def extend(schemas, endpoint, paths):
    string = {"type": "string"}
    integer = {"type": "integer"}
    uuid = {"type": "string", "format": "uuid"}
    timestamp = {"type": "string", "format": "date-time"}
    date = {"type": "string", "format": "date"}

    def obj(properties, required=None):
        return {
            "type": "object",
            "properties": properties,
            "required": list(properties) if required is None else required,
            "additionalProperties": False,
        }

    def ref(name):
        return {"$ref": "#/components/schemas/" + name}

    schemas["CustomerJourneyDetails"] = obj(
        {
            "path": string,
            "query": string,
            "result_count": integer,
            "traffic_source": string,
            "product_id": uuid,
            "product_name": string,
            "category_name": string,
            "quantity": integer,
            "proposal_id": uuid,
            "mode": string,
            "amount": string,
            "currency": string,
            "payment_method": string,
            "item_count": integer,
            "order_id": uuid,
            "order_number": integer,
            "status": string,
        },
        [],
    )
    schemas["CustomerJourneyEvent"] = obj(
        {
            "id": string,
            "occurred_at": timestamp,
            "kind": {
                "type": "string",
                "enum": [
                    "visit",
                    "page_view",
                    "product_view",
                    "category_view",
                    "search",
                    "cart.item_added",
                    "cart.item_removed",
                    "shopping.proposal_created",
                    "shopping.cart_applied",
                    "checkout",
                    "purchase",
                    "order_status",
                ],
            },
            "source": {"type": "string", "enum": ["storefront", "commerce"]},
            "session_id": {**uuid, "nullable": True},
            "details": ref("CustomerJourneyDetails"),
        }
    )
    cursor = obj({"before": timestamp, "before_id": string})
    schemas["CustomerJourney"] = obj(
        {
            "customer": obj(
                {"id": uuid, "name": string, "email": {**string, "nullable": True}}
            ),
            "from": date,
            "to": date,
            "includes_orders": {"type": "boolean"},
            "events": {"type": "array", "items": ref("CustomerJourneyEvent")},
            "next_cursor": {**cursor, "nullable": True},
        }
    )
    path = "/v1/admin/customers/{id}/journey"
    endpoint(path, "get", "CustomerJourney", auth="adminSession")
    paths[path]["get"]["parameters"] += [
        {"in": "query", "name": name, "schema": schema}
        for name, schema in [
            ("from", date),
            ("to", date),
            ("before", timestamp),
            ("before_id", string),
            ("limit", {"type": "integer", "minimum": 1, "maximum": 100}),
        ]
    ]
    paths[path]["get"]["description"] = (
        "Requires customers.read; checkout and order events are included only with orders.read. Dates are inclusive UTC days, up to 90 days per range."
    )
    paths["/v1/analytics/events"]["post"]["description"] = (
        "Anonymous aggregate analytics. With a valid optional customer bearer token, page/search observations are also recorded for that authenticated customer's journey. Customer identifiers and timestamps are never accepted from the payload."
    )
