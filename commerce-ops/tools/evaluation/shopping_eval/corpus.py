"""Independent, authored expectations. Never derive labels from engine output."""

import hashlib
import json
import random

VERSION = "synthetic-shoppers-v1"
PRODUCTS = [
    "apples", "bananas", "oranges", "rice", "milk", "coffee", "tea", "pasta",
    "olive oil", "tomatoes", "potatoes", "carrots", "yogurt", "cheese",
    "oat milk", "almond milk", "brown rice", "lentils", "chickpeas", "dates",
    "shoes", "running shoes", "shirts", "socks", "jackets", "jeans", "hats",
    "mugs", "plates", "towels", "pillows", "notebooks", "pens", "backpacks",
    "headphones", "keyboards", "chargers", "batteries", "soap", "shampoo",
    "sunscreen", "moisturizer", "diapers", "baby wipes", "cat food", "dog food",
    "quasar widgets", "veltronic modules", "linen napkins", "copper fasteners",
]
PREFIXES = ["", "please ", "could you ", "can you ", "pls ", "would you "]
FAMILIES = (
    "search", "conversational_search", "typos", "price_constraints",
    "add_cart", "remove_cart", "wishlist_to_cart", "cart_to_wishlist",
    "negation", "conflicting_actions", "compound_checkout", "address_followup",
    "product_followup", "arabic", "mixed_language", "requirements_review",
)


def expectation(intent=None, status="RESOLVED", **paths):
    return {"status": status, "intent": intent, "paths": paths}


def candidate(family, rng):
    product = rng.choice(PRODUCTS)
    quantity = rng.randint(1, 12)
    price = rng.choice(list(range(10, 1001, 5)))
    prefix = rng.choice(PREFIXES)
    language, scope, kind = "en", "english", "semantic"
    expected = expectation("PRODUCT_SEARCH", **{"entities.productText": product})
    if family == "search":
        text = f"{prefix}{rng.choice(['find', 'show me', 'search for', 'look for'])} {product} under ${price}"
        expected["paths"].update({"entities.price.value": price, "entities.price.currency": "USD", "entities.price.operator": "<="})
    elif family == "conversational_search":
        text = f"{prefix}{rng.choice(['I am looking for', 'do you sell', 'do you carry', 'help me find', 'I need', 'got any', 'I was hoping to buy'])} {product} under ${price}"
        expected["paths"].update({"entities.price.value": price, "entities.price.currency": "USD"})
    elif family == "typos":
        text = f"{prefix}{rng.choice(['fnd', 'serch for', 'showw me', 'lok for', 'looking fr'])} {product} under ${price}"
        expected["paths"]["entities.price.value"] = price
    elif family == "price_constraints":
        phrase, operator = rng.choice([("at most", "<="), ("above", ">="), ("below", "<="), ("under", "<=")])
        text = f"{prefix}find {product} {phrase} ${price}"
        expected["paths"].update({"entities.price.value": price, "entities.price.currency": "USD", "entities.price.operator": operator})
    elif family in {"add_cart", "remove_cart"}:
        add = family == "add_cart"
        verb = rng.choice(["add", "put"]) if add else rng.choice(["remove", "delete"])
        text = f"{prefix}{verb} {quantity} {product} {'to' if add else 'from'} my {rng.choice(['cart', 'basket', 'shopping cart'])}"
        expected = expectation("ADD_TO_CART" if add else "REMOVE_FROM_CART", **{"entities.productText": product, "entities.quantity": quantity})
    elif family in {"wishlist_to_cart", "cart_to_wishlist"}:
        source, destination = ("wishlist", "cart") if family == "wishlist_to_cart" else ("cart", "wishlist")
        verb = rng.choice(["move", "transfer"])
        text = f"{prefix}{verb} {quantity} {product} from my {source} to the {destination}"
        expected = expectation("CART_MOVE_FROM_WISHLIST" if source == "wishlist" else "CART_MOVE_TO_WISHLIST", **{"entities.productText": product, "entities.quantity": quantity, "entities.sourceCollection": source, "entities.destination": destination})
    elif family == "negation":
        text = f"{rng.choice(['do not', 'never', 'please do not'])} {rng.choice(['add', 'put'])} {quantity} {product} in my {rng.choice(['cart', 'basket', 'shopping cart'])}"
        expected = expectation(None, "UNKNOWN")
    elif family == "conflicting_actions":
        text = f"{prefix}show me {product} under ${price} or cancel my order"
        expected = expectation(None, "AMBIGUOUS")
    elif family == "compound_checkout":
        second = rng.choice([p for p in PRODUCTS if p != product])
        text = f"{prefix}add {quantity} {product} and 2 {second} then checkout"
        expected = expectation("START_CHECKOUT", **{"entities.items": [{"productText": product, "quantity": quantity}, {"productText": second, "quantity": 2}], "operations": ["ADD_ITEM", "START_CHECKOUT"], "fulfillment.status": "NOT_EXECUTED"})
    elif family == "address_followup":
        text = f"{prefix}create an order for {quantity} {product} and deliver it there"
        address = rng.choice(["home", "work"])
        return {"messages": [text, address], "expectations": [expectation("CREATE_ORDER", "NEEDS_CONTEXT"), expectation("CREATE_ORDER", **{"entities.items.0.productText": product, "entities.items.0.quantity": quantity, "entities.delivery.addressReference": address.upper()})], "language": language, "scope": scope, "oracle_kind": kind}
    elif family == "product_followup":
        text = f"{prefix}add {quantity} {rng.choice(['items', 'products'])} to my {rng.choice(['cart', 'basket', 'shopping cart'])}"
        return {"messages": [text, product], "expectations": [expectation("ADD_TO_CART", "NEEDS_CONTEXT"), expectation("ADD_TO_CART", **{"entities.items.0.productText": product, "entities.items.0.quantity": quantity})], "language": language, "scope": scope, "oracle_kind": kind}
    elif family == "arabic":
        language, scope = "ar", "expansion_target"
        noun = rng.choice(["حليب", "قهوة", "أرز", "شامبو", "تفاح", "حذاء", "سماعات", "شاي", "جبنة", "عدس"])
        text = f"{rng.choice(['عايز', 'محتاج', 'بدور على', 'عندكم', 'ممكن ألاقي', 'أبحث عن', 'أريد'])} {noun} {rng.choice(['بأقل من', 'بسعر أقل من', 'تحت'])} {price} {rng.choice(['جنيه', 'دولار'])}"
        expected = expectation("PRODUCT_SEARCH")
    elif family == "mixed_language":
        language, scope = "ar-en", "expansion_target"
        text = f"{rng.choice(['عايز', 'محتاج', 'بدور على', 'عندكم'])} {product} under ${price}"
        expected = expectation("PRODUCT_SEARCH", **{"entities.price.value": price})
    else:
        kind = "human_review"
        need = rng.choice(["safe for a severe peanut allergy", "suitable during pregnancy", "compatible with my old device", "vegan with no hidden animal ingredients", "delivered tomorrow before 9am", "the best value for a family of five"])
        text = f"{prefix}I need {product} under ${price}, {need}. What would you suggest?"
        expected = None  # No fabricated automated oracle for factual advice.
    return {"messages": [text], "expectations": [expected], "language": language, "scope": scope, "oracle_kind": kind}


def generate(count=100000, seed=20260923):
    rng, seen = random.Random(seed), set()
    for i in range(count):
        family = FAMILIES[i % len(FAMILIES)]
        for _ in range(10000):
            case = candidate(family, rng)
            identity = json.dumps(case["messages"], ensure_ascii=False)
            if identity not in seen:
                break
        else:
            raise ValueError(f"Unique corpus capacity exhausted for {family}; reduce --count")
        seen.add(identity)
        yield {"id": hashlib.sha256(identity.encode()).hexdigest()[:20], "family": family, **case}
