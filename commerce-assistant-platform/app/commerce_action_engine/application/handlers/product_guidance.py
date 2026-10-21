"""Selection-card presentation from validated interpretation semantics."""

from app.commerce_action_engine.contracts import AssistantProductPrompt
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest


def product_prompts(request: InterpretedRequest) -> list[AssistantProductPrompt]:
    entities = request.entities
    queries = entities.get("productQueries") or [entities.get("productText")]
    items = entities.get("items")
    if not items:
        if not isinstance(queries, list):
            raise ValueError("Invalid product guidance queries")
        items = [
            {"productText": query, "quantity": entities.get("quantity", 1)}
            for query in queries
        ]
    if not isinstance(items, list) or not items:
        raise ValueError("Invalid product guidance items")
    prompts = []
    for item in items[:50]:
        if not isinstance(item, dict):
            raise TypeError("Invalid product guidance item")
        prompts.append(
            AssistantProductPrompt.model_validate(
                {
                    "query": item.get("productText"),
                    "quantity": item.get("quantity", 1),
                    "action": entities.get("guideAction", "choose"),
                }
            )
        )
    return prompts


def prompt_message(prompts: list[AssistantProductPrompt]) -> str:
    return (
        "Let's find the products for your order first. Choose a matching product for each request below. Nothing has been added or ordered yet."
        if len(prompts) > 1 or prompts[0].action == "cart"
        else "I can help you choose a matching product. What would you like to do?"
        if prompts[0].action in {"choose", "remove"}
        else "Choose two to five products to compare."
    )
