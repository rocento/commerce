"""Authored synthetic conversations; expectations never use resolver predictions.

Held-out means held out by this corpus's template partition, not unseen during
model training or an independently human-labeled gold dataset.
"""

import hashlib
import json
import random

from .corpus import PRODUCTS as LEGACY_PRODUCTS
from .corpus import expectation

PRODUCTS = LEGACY_PRODUCTS + [
    "dish soap",
    "laundry detergent",
    "paper towels",
    "toilet paper",
    "trash bags",
    "sponges",
    "brooms",
    "storage boxes",
    "glass jars",
    "water bottles",
    "lunch boxes",
    "frying pans",
    "saucepans",
    "cutting boards",
    "kitchen scales",
    "measuring cups",
    "tea kettles",
    "coffee filters",
    "baking trays",
    "oven gloves",
    "flour",
    "sugar",
    "salt",
    "black pepper",
    "cumin",
    "peanut butter",
    "strawberry jam",
    "honey",
    "granola",
    "oats",
    "cornflakes",
    "crackers",
    "dark chocolate",
    "tuna",
    "frozen peas",
    "frozen spinach",
    "chicken breast",
    "beef mince",
    "eggs",
    "butter",
    "tofu",
    "coconut milk",
    "sparkling water",
    "orange juice",
    "tomato sauce",
    "canned beans",
    "couscous",
    "quinoa",
    "sesame oil",
    "soy sauce",
    "toothpaste",
    "toothbrushes",
    "dental floss",
    "hand cream",
    "lip balm",
    "shower gel",
    "razors",
    "cotton pads",
    "tissues",
    "hair brushes",
    "charging cables",
    "phone cases",
    "screen protectors",
    "wireless mice",
    "desk lamps",
    "extension cords",
    "light bulbs",
    "power banks",
    "bike helmets",
    "yoga mats",
    "resistance bands",
    "tennis balls",
    "swim goggles",
    "umbrellas",
    "wallets",
    "belts",
    "slippers",
    "pajamas",
    "bed sheets",
    "pillowcases",
]

VERSION = "synthetic-shoppers-v2.2"
MUTATIONS = [
    "ADD_TO_CART",
    "REMOVE_FROM_CART",
    "CLEAR_CART",
    "UPDATE_CART_QUANTITY",
    "CREATE_ORDER",
    "START_CHECKOUT",
    "CANCEL_ORDER",
    "ADD_TO_WISHLIST",
    "CART_MOVE_FROM_WISHLIST",
    "CART_MOVE_TO_WISHLIST",
]
TEMPLATES = {
    "search": [
        "find {p} under ${price}",
        "show me {p} below ${price}",
        "search for {p} under ${price}",
        "look for {p} below ${price}",
    ],
    "conversational_search": [
        "I need {p} under ${price}.",
        "Got any {p} under ${price}?",
        "I was hoping to buy {p} under ${price}.",
        "I'm trying to find {p} for less than ${price}.",
    ],
    "typos": [
        "fnd {p} under ${price}",
        "serch for {p} under ${price}",
        "showw me {p} under ${price}",
        "could you fnd {p} below ${price}?",
    ],
    "price_constraints": [
        "find {p} at most ${price}",
        "show me {p} up to ${price}",
        "find {p} below ${price}",
        "I need {p} under ${price}",
    ],
    "add_cart": [
        "add {q} {p} to my cart",
        "put {q} {p} in my basket",
        "please add {q} {p} to the shopping cart",
        "could you put {q} {p} into my cart?",
    ],
    "remove_cart": [
        "remove {q} {p} from my cart",
        "delete {q} {p} from my basket",
        "please remove {q} {p} from the shopping cart",
        "could you take {q} {p} out of my cart?",
    ],
    "wishlist_to_cart": [
        "move {q} {p} from my wishlist to my cart",
        "transfer {q} {p} from wishlist to cart",
        "please move {q} {p} from my wishlist into my basket",
        "take {q} {p} from my wishlist and put them in my cart",
    ],
    "cart_to_wishlist": [
        "move {q} {p} from my cart to my wishlist",
        "transfer {q} {p} from cart to wishlist",
        "please move {q} {p} from my basket into my wishlist",
        "take {q} {p} from my cart and save them in my wishlist",
    ],
    "negation": [
        "don't add {q} {p} to my cart",
        "I don't need {p} under ${price}",
        "never remove {q} {p} from my basket",
        "please don't buy {q} {p}",
    ],
    "conflicting_actions": [
        "show me {p} under ${price} or cancel my order",
        "add {q} {p} to my cart or remove them",
        "buy {q} {p} or save them for later, I haven't decided",
        "should I buy {q} {p} or cancel my order?",
    ],
    "compound_checkout": [
        "add {q} {p} and {q2} {p2} then checkout",
        "put {q} {p} and {q2} {p2} in my cart then checkout",
        "add {q} {p}, add {q2} {p2}, then checkout",
        "first add {q} {p} and {q2} {p2}, then start checkout",
    ],
    "address_followup": [
        "create an order for {q} {p} and deliver it there",
        "please create an order for {q} {p} and deliver it there",
        "order {q} {p} and ship it there",
        "I'd like to order {q} {p}; deliver them there",
    ],
    "product_followup": [
        "add {q} items to my cart",
        "please add {q} products to my basket",
        "put {q} items in my cart",
        "could you add {q} products to the shopping cart?",
        "please put {q} items into my shopping cart",
        "I'd like {q} products added to my cart",
        "can you add {q} items to my basket, please?",
        "I want to add {q} items to my cart",
    ],
    "arabic": [
        "عايز {ar} بأقل من {price} جنيه",
        "محتاج {ar} تحت {price} جنيه",
        "أبحث عن {ar} بسعر أقل من {price} جنيه",
        "ممكن ألاقي {ar} بميزانية {price} جنيه؟",
    ],
    "mixed_language": [
        "عايز {p} under ${price}",
        "محتاج {p} below ${price}",
        "عندكم {p} under ${price}؟",
        "ممكن show me {p} under ${price}",
    ],
    "requirements_review": [
        "I need {p} under ${price}, {need}. What would you suggest?",
        "Can you recommend {p} below ${price} that are {need}?",
        "I'm looking for {p} under ${price}; they must be {need}.",
        "My budget is ${price} for {p}. I need them to be {need}.",
    ],
    "strict_minimum": [
        "find {p} above ${price}",
        "find {p} over ${price}",
        "show me {p} more than ${price}",
        "I need {p} costing more than ${price}",
    ],
    "price_ranges": [
        "find {p} above ${price} and under ${high}",
        "show me {p} over ${price} and below ${high}",
        "find {p} at least ${price} and at most ${high}",
        "I need {p} between ${price} and ${high}",
    ],
    "quoted_identity": [
        'find "{sku}"',
        'search for "{sku}"',
        'show me "{sku}"',
        'do you carry "{sku}"?',
    ],
    "punctuation": [
        "FIND {p} UNDER ${price}!",
        "find   {p}   under   ${price}",
        "find\t{p}\tunder ${price}",
        "Please, find {p} under ${price}. Thanks!",
    ],
    "quantity_limits": [
        "add 0 {p} to my cart, budget ${price}",
        "add -{q} {p} to my cart, budget ${price}",
        "add 1000001 {p} to my cart, budget ${price}",
        "add {q}.5 {p} to my cart, budget ${price}",
    ],
    "order_tracking": [
        "track order {order}",
        "where is order {order}?",
        "show me the shipping status of order {order}",
        "could you track my order {order}, please?",
    ],
    "order_cancellation": [
        "cancel order {order}",
        "please cancel my order {order}",
        "I want to cancel order {order}",
        "can you cancel order {order} for me?",
    ],
    "coupons": [
        "apply coupon {coupon}",
        "use discount code {coupon}",
        "please apply promo code {coupon}",
        "can you use coupon {coupon} on my cart?",
    ],
    "stock_queries": [
        "is {sku} in stock?",
        "check stock for {sku}",
        "do you have {sku} available?",
        "can you check whether {sku} is available now?",
    ],
    "product_comparisons": [
        "compare {sku} and {sku2}",
        "what's the difference between {sku} and {sku2}?",
        "compare the features of {sku} and {sku2}",
        "help me compare {sku} with {sku2}",
    ],
    "context_corrections_review": [
        "find {p} under ${price}",
        "show me {p} below ${price}",
        "I need {p} under ${price}",
        "I'm shopping for {p} below ${price}",
    ],
    "unsupported_conditions_review": [
        "find {p} under ${price} unless delivery costs extra",
        "buy {q} {p} only if my partner approves",
        "add {q} {p} if they're cheaper than yesterday",
        "find {p} under ${price}, excluding anything made in a factory",
    ],
    "quoted_commands": [
        'find "add {q} {p} to cart"',
        'search for "cancel order {order}"',
        'show me "remove {q} {p}"',
        'find a product named "checkout {sku}"',
    ],
    "negated_search": [
        "I don't want {p} under ${price}",
        "don't search for {p} under ${price}",
        "I am not looking for {p} under ${price}",
        "I was not hoping to buy {p} under ${price}",
    ],
    "device_requirements_review": [
        "find {p} under ${price} compatible with my {sku}",
        "I need {p} for {sku}, budget ${price}",
        "will {p} under ${price} work with {sku}?",
        "recommend {p} below ${price} that support {sku}",
    ],
    "unicode_currency": [
        "find {p} under £{price}",
        "show me {p} below €{price}",
        "find {p} under {price} EGP",
        "I need {p} under USD {price}",
    ],
}
FAMILIES = tuple(TEMPLATES)
NEEDS = [
    "safe for a severe peanut allergy",
    "suitable during pregnancy",
    "compatible with my old device",
    "vegan with no hidden animal ingredients",
    "delivered tomorrow before 9am",
    "the best value for a family of five",
]


def candidate(family, rng):
    index = rng.randrange(len(TEMPLATES[family]))
    p, p2 = rng.sample(PRODUCTS, 2)
    q, q2 = rng.randint(1, 50), rng.randint(1, 12)
    price = rng.randint(5, 5000)
    sku = f"{rng.choice(['Fnd', 'Showw', 'Search', 'Nova', 'Acme'])}-{rng.randint(1000, 99999)}"
    data = {
        "p": p,
        "p2": p2,
        "q": q,
        "q2": q2,
        "price": price,
        "high": price + rng.randint(1, 500),
        "sku": sku,
        "sku2": f"Orion-{rng.randint(1000, 99999)}",
        "order": rng.randint(100000, 999999),
        "coupon": f"SAVE{rng.randint(10000, 99999)}",
        "ar": rng.choice(
            [
                "حليب",
                "قهوة",
                "أرز",
                "شامبو",
                "تفاح",
                "حذاء",
                "سماعات",
                "شاي",
                "جبنة",
                "عدس",
            ]
        ),
        "need": rng.choice(NEEDS),
    }
    message = TEMPLATES[family][index].format(**data)
    expected = expectation("PRODUCT_SEARCH")
    expected["normalized_paths"] = {"entities.productText": p}
    scope, language, kind, risk = "english", "en", "semantic", "read"
    messages = [message]
    if family in {
        "search",
        "conversational_search",
        "typos",
        "price_constraints",
        "punctuation",
    }:
        expected["paths"] = {
            "entities.price.value": price,
            "entities.price.currency": "USD",
        }
    elif family in {"add_cart", "remove_cart", "wishlist_to_cart", "cart_to_wishlist"}:
        expected["intent"] = {
            "add_cart": "ADD_TO_CART",
            "remove_cart": "REMOVE_FROM_CART",
            "wishlist_to_cart": "CART_MOVE_FROM_WISHLIST",
            "cart_to_wishlist": "CART_MOVE_TO_WISHLIST",
        }[family]
        expected["paths"] = {"entities.quantity": q}
        risk = "mutation"
        if "wishlist" in family:
            expected["paths"].update(
                {
                    "entities.sourceCollection": "wishlist"
                    if family == "wishlist_to_cart"
                    else "cart",
                    "entities.destination": "cart"
                    if family == "wishlist_to_cart"
                    else "wishlist",
                }
            )
    elif family in {
        "negation",
        "negated_search",
        "quoted_commands",
        "quantity_limits",
        "conflicting_actions",
    }:
        expected = {
            "forbid_resolved_intents": MUTATIONS
            + (
                ["PRODUCT_SEARCH", "PRODUCT_RECOMMEND"]
                if family in {"negated_search", "negation"}
                else []
            )
        }
        kind, risk = "safety_invariant", "safety"
    elif family == "compound_checkout":
        expected = expectation(
            "START_CHECKOUT",
            **{
                "entities.items": [
                    {"productText": p, "quantity": q},
                    {"productText": p2, "quantity": q2},
                ],
                "operations": ["ADD_ITEM", "START_CHECKOUT"],
                "fulfillment.status": "NOT_EXECUTED",
            },
        )
        risk = "mutation"
        if index == 2:
            # Two explicit add clauses may be grouped or represented separately.
            # Item quantities and the checkout ordering are still mandatory.
            expected["paths"].pop("operations")
            expected["any_of_paths"] = {
                "operations": [
                    ["ADD_ITEM", "START_CHECKOUT"],
                    ["ADD_ITEM", "ADD_ITEM", "START_CHECKOUT"],
                ]
            }
    elif family == "address_followup":
        address = rng.choice(["home", "work"])
        messages.append(address)
        expected = [
            expectation("CREATE_ORDER", "NEEDS_CONTEXT"),
            expectation(
                "CREATE_ORDER",
                **{
                    "entities.items.0.productText": p,
                    "entities.items.0.quantity": q,
                    "entities.delivery.addressReference": address.upper(),
                },
            ),
        ]
        risk = "mutation"
    elif family == "product_followup":
        messages.append(p)
        expected = [
            expectation("ADD_TO_CART", "NEEDS_CONTEXT"),
            expectation(
                "ADD_TO_CART",
                **{"entities.items.0.productText": p, "entities.items.0.quantity": q},
            ),
        ]
        risk = "mutation"
    elif family in {"arabic", "mixed_language"}:
        language = "ar" if family == "arabic" else "ar-en"
        scope = "expansion_target"
        expected = expectation("PRODUCT_SEARCH")
    elif family.endswith("review"):
        expected, kind = None, "human_review"
        if family == "context_corrections_review":
            messages += [
                f"Actually, make the budget ${data['high']}.",
                f"And only {rng.choice(['black', 'blue', 'white'])} ones, please.",
            ]
            expected = [None] * 3
    elif family in {"strict_minimum", "price_ranges"}:
        expected["plan"] = {
            "min_price": str(price),
            "exclusive_min": family == "strict_minimum" or index < 2,
        }
        if family == "price_ranges":
            expected["plan"].update(
                max_price=str(data["high"]), exclusive_max=index < 2
            )
    elif family == "quoted_identity":
        expected["normalized_paths"] = {"entities.productText": sku}
    elif family in {
        "order_tracking",
        "order_cancellation",
        "coupons",
        "stock_queries",
        "product_comparisons",
    }:
        code = {
            "order_tracking": "TRACK_ORDER",
            "order_cancellation": "CANCEL_ORDER",
            "coupons": "APPLY_COUPON",
            "stock_queries": "CHECK_STOCK",
            "product_comparisons": "COMPARE_PRODUCTS",
        }[family]
        expected = expectation(code)
        scope = "expanded_intent"
        risk = "mutation" if family in {"order_cancellation", "coupons"} else "read"
        if family == "product_comparisons":
            # Generic comparison, feature comparison and advice can have distinct intents.
            expected = None
            kind = "human_review"
    elif family == "unicode_currency":
        expected["paths"] = {
            "entities.price.value": price,
            "entities.price.currency": ["GBP", "EUR", "EGP", "USD"][index],
        }
    return {
        "messages": messages,
        "expectations": expected if isinstance(expected, list) else [expected],
        "language": language,
        "scope": scope,
        "oracle_kind": kind,
        "risk": risk,
        "template_id": f"{family}:{index}",
        "split": "holdout" if index % 4 == 3 else "development",
    }


def generate(count=500000, seed=20260923, language_scope="english"):
    if language_scope not in {"all", "english"}:
        raise ValueError("Unknown language scope")
    families = tuple(
        f
        for f in FAMILIES
        if language_scope == "all" or f not in {"arabic", "mixed_language"}
    )
    rng, seen = random.Random(seed), set()
    for i in range(count):
        family = families[i % len(families)]
        for _ in range(10000):
            row = candidate(family, rng)
            identity = json.dumps(row["messages"], ensure_ascii=False)
            digest = hashlib.sha256(identity.encode()).hexdigest()
            if digest not in seen:
                break
        else:
            raise ValueError(f"Unique corpus capacity exhausted for {family}")
        seen.add(digest)
        yield {"id": digest[:20], "family": family, **row}
