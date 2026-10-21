"""Exercise real language output at the Python action-admission boundary."""

import json
import subprocess
from pathlib import Path

from interpretation_helpers import standard_route

from app.commerce_action_engine.execution.language.gate import Resolution


def test_conversational_transfers_and_followups_keep_action_routes():
    conversations = [
        ["take 12 pillowcases from my wishlist and put them in my cart"],
        ["take 49 water bottles from my cart and save them in my wishlist"],
        ["first add 30 tea kettles and 2 yogurt, then start checkout"],
        ["I'd like to order 19 frozen peas; deliver them there", "work"],
        ["order 3 cornflakes and ship it there", "home"],
        ["I'd like 5 products added to my cart", "butter"],
        ["take -7 shoes from wishlist and put them in cart"],
    ]
    engine = Path(__file__).resolve().parents[1] / "app/commerce_language_engine"
    result = subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            (
                "import {loadRuntime} from './src/runtime.ts';"
                "import {resolve} from './src/engine.ts';const c=await loadRuntime();"
                "console.log(JSON.stringify(JSON.parse(process.argv[1]).map(messages=>{"
                "let context={};return messages.map(text=>{const r=resolve(c,text,context);"
                "context=r.context.next;return r;});})));"
            ),
            json.dumps(conversations),
        ],
        cwd=engine,
        capture_output=True,
        text=True,
        check=True,
    )
    raw_runs = json.loads(result.stdout)
    runs = [[Resolution.model_validate(r) for r in run] for run in raw_runs]
    assert [[standard_route(r) for r in run] for run in runs] == [
        ["wishlist_to_cart"],
        ["cart_action"],
        ["guided_action"],
        ["clarify", "guided_action"],
        ["clarify", "guided_action"],
        ["clarify", "cart_action"],
        ["clarify"],
    ]
    for run in raw_runs:
        for r in run:
            assert r["fulfillment"]["status"] == "NOT_EXECUTED"
    assert runs[0][0].entities["quantity"] == 12
    assert runs[1][0].entities["sourceCollection"] == "cart"
    assert runs[2][0].operations == ["ADD_ITEM", "START_CHECKOUT"]
    assert runs[3][1].entities["items"] == [
        {"quantity": 19, "productText": "frozen peas"}
    ]
    assert runs[4][1].entities["delivery"]["addressReference"] == "HOME"
    assert runs[5][1].entities["items"] == [{"quantity": 5, "productText": "butter"}]
