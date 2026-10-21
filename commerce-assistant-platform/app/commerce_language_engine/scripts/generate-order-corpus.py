import hashlib
import json
from pathlib import Path

root = Path(__file__).resolve().parent.parent / "tests/fixtures/order-requests-v1"
# Authored language frames and independently specified product/quantity labels.
frames = [
    "create order {items}",
    "please create an order for {items}",
    "pls make an order with {items}",
    "plz place order: {items}",
    "start a new order for {items}",
    "make me an order for {items}",
    "create a shopping order with {items}",
    "place my order for {items}",
    "can you create an order for {items}?",
    "could you please place an order with {items}?",
    "would you make an order for {items}, please?",
    "please help me order {items}",
    "help me buy {items}",
    "I want to order {items}",
    "we want to buy {items}",
    "I would like to purchase {items}",
    "I'd like to order {items}",
    "we'd like to buy {items}",
    "I need to order {items}",
    "we need to purchase {items}",
    "I want {items}",
    "I would like {items}",
    "I'd like {items}",
    "can I get {items}?",
    "could I have {items} please?",
    "may I order {items}?",
    "can I buy {items}?",
    "buy {items}",
    "purchase {items}",
    "order {items}",
    "please order {items} for me",
    "buy me {items}",
    "get me {items}",
    "please get me {items}",
    "I will take {items}",
    "I'll take {items}",
    "we will take {items}",
    "we'll take {items}",
    "I would like to get {items}",
    "we would like to have {items}",
    "hi, please order {items}",
    "hello! I want to buy {items}",
    "hey, could you order {items}?",
    "good morning, please buy {items}",
    "good evening, can I get {items}?",
    "please place an order for {items}, thanks",
    "order {items}, thank you",
    "I want to place an order for {items}",
    "we would like to create an order with {items}",
    "I'd like to make an order for {items}",
    "can you help me buy {items}?",
    "could you help me order {items}?",
    "would you please get me {items}?",
    "please purchase {items} please",
    "pls order {items}",
    "plz buy {items}",
    "kindly order {items}",
    "can u order {items}?",
    "could u please buy {items}?",
    "i wanna order {items}",
    "we wanna buy {items}",
    "i want to ordar {items}",
    "please crete an order for {items}",
    "please craete order {items}",
    "please oder {items}",
    "I am looking to buy {items}",
    "I'm looking to order {items}",
    "we are looking to purchase {items}",
    "place a grocery order for {items}",
    "please start my order with {items}",
]
assert len(frames) == 70, len(frames)
variants = [
    ("2 banans 3 apples 2 baladi", [("banans", 2), ("apples", 3), ("baladi", 2)]),
    ("two bananas and three apples", [("bananas", 2), ("apples", 3)]),
    ("1 milk, 2 eggs, 3 rice", [("milk", 1), ("eggs", 2), ("rice", 3)]),
    ("2 green apples and 1 baladi bread", [("green apples", 2), ("baladi bread", 1)]),
    ("4 chesse & 2 tomatos", [("chesse", 4), ("tomatos", 2)]),
    ("2x bananas, 3x apples", [("bananas", 2), ("apples", 3)]),
    ("bananas x2 and apples x3", [("bananas", 2), ("apples", 3)]),
    ("twelve eggs and twenty apples", [("eggs", 12), ("apples", 20)]),
    (
        "1 olive oil, 2 yogurt, 3 dates, 1 honey, 2 lemons",
        [("olive oil", 1), ("yogurt", 2), ("dates", 3), ("honey", 1), ("lemons", 2)],
    ),
    ("2 SKU-GRN-007 and 1 oat milk", [("SKU-GRN-007", 2), ("oat milk", 1)]),
]
guards = [
    ("negation", "do not order {item}"),
    ("negation", "please never buy {item}"),
    ("condition", "order {item} only if it is in stock"),
    ("condition", "buy {item} unless delivery is expensive"),
    ("budget", "create order {item} under 100 EGP"),
    ("budget", "please order {item} with a total budget of 200 EGP"),
    ("exclusion", "order {item} without sugar"),
    ("substitution", "order {item} or substitute the cheapest option"),
    ("cart_policy", "order {item} and keep my current cart"),
    ("cart_policy", "clear my cart then order {item}"),
    ("cart_policy", "create order {item} instead of the products already in my cart"),
    ("delivery", "order {item} and deliver tomorrow morning"),
    ("delivery", "please buy {item} and ship to my office"),
    ("payment", "order {item} and pay with my saved card"),
    ("payment", "buy {item} cash on delivery"),
    ("reorder", "order {item} like my previous order"),
    ("reorder", "order the same {item} again"),
    ("confirmation", "order {item} but ask me before adding anything"),
    ("invalid_quantity", "create order 0 {name}"),
    ("invalid_quantity", "create order -2 {name}"),
    ("invalid_quantity", "create order 1.5 {name}"),
    ("units", "create order 2 kg {name}"),
    ("units", "create order half a kilo of {name}"),
    ("units", "buy a dozen {name}"),
    ("conflicting_quantity", "order two 3 {name}"),
    ("unsafe_compound", "order {item}; cancel order 42"),
    ("correction", "order {item}, actually make that five"),
    ("alternatives", "order either {item} or milk"),
    ("ambiguous_reference", "order {item} and the other one"),
    ("constraint", "order {item} with no substitutions"),
]
assert len(guards) == 30
rows = []
for f, frame in enumerate(frames):
    for v, (items, expected) in enumerate(variants):
        rows.append(
            {
                "id": f"order-{f + 1:02}-{v + 1:02}",
                "family": f"phrase-{f + 1:02}",
                "split": "holdout" if f % 5 == 4 else "development",
                "text": frame.format(items=items),
                "expected": {
                    "kind": "selection",
                    "items": [{"productText": n, "quantity": q} for n, q in expected],
                },
            }
        )
for g, (family, frame) in enumerate(guards):
    for v, name in enumerate(
        [
            "bananas",
            "apples",
            "baladi",
            "milk",
            "eggs",
            "chesse",
            "rice",
            "tomatos",
            "yogurt",
            "lemons",
        ]
    ):
        rows.append(
            {
                "id": f"guard-{g + 1:02}-{v + 1:02}",
                "family": family,
                "split": "holdout" if g % 5 == 4 else "development",
                "text": frame.format(item=f"{v % 3 + 1} {name}", name=name),
                "expected": {"kind": "clarify"},
            }
        )
assert len(rows) == 1000 and len({r["text"] for r in rows}) == 1000
hashes: dict[str, str] = {}
manifest = {
    "version": 1,
    "count": 1000,
    "selection": 700,
    "clarification": 300,
    "language": "English, including local product names and typos",
    "provenance": "Synthetic, assistant-authored 100 language frames crossed with 10 independently labeled baskets/products. Not production conversations.",
    "split": "800 development / 200 template-held-out. Frozen before engine changes; shared vocabulary means this is not an independent real-world benchmark.",
    "sha256": hashes,
}
for split in ["development", "holdout"]:
    content = "".join(
        json.dumps(r, ensure_ascii=False) + "\n" for r in rows if r["split"] == split
    )
    (root / f"{split}.jsonl").write_text(content)
    hashes[f"{split}.jsonl"] = hashlib.sha256(content.encode()).hexdigest()
(root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
