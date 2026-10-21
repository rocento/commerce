"""Prepare one shopping plan while keeping monetary and non-monetary evidence separate."""

import re
from decimal import Decimal, InvalidOperation

from app.commerce_action_engine.actions.catalog import (
    CatalogSchema,
)
from app.commerce_action_engine.actions.shopping.constraints import (
    normalized,
    numeric_constraints,
)
from app.commerce_action_engine.actions.shopping.context import (
    contextual_message,
    verified_context,
)
from app.commerce_action_engine.actions.shopping.contracts import (
    ShoppingClarification,
    ShoppingIntent,
)
from app.commerce_action_engine.actions.shopping.meaning import (
    MeaningConflict,
    interpret,
)
from app.commerce_action_engine.actions.shopping.personalization import (
    restore as personalization_restore,
)
from app.commerce_action_engine.actions.shopping.pricing import (
    retain_price_bounds,
)
from app.commerce_action_engine.actions.shopping.quantity_language import (
    quantity_comparisons,
)
from app.commerce_action_engine.application.interpretation import shopping_plan
from app.commerce_action_engine.contracts.interpretation import (
    InterpretationFailure,
    InterpretedRequest,
)
from app.commerce_action_engine.execution.agents import Agent
from app.commerce_action_engine.execution.core.meaning import clarify
from app.commerce_action_engine.execution.language.shopping import (
    english_query,
    refine_query,
)
from app.commerce_action_engine.platform import meaning_summary
from app.commerce_resolution_engine.contracts import (
    Message,
    ModelProvider,
    ModelResponse,
    Usage,
)
from app.commerce_resolution_engine.shopping import (
    resolve_shopping,
    shopping_plan_from_response,
    shopping_request,
)

from .catalog import ShoppingCatalog
from .contracts import PreparedShopping, ShoppingAnswer


async def prepare_shopping(
    *,
    message: str,
    schema: CatalogSchema,
    catalog: ShoppingCatalog,
    provider: ModelProvider,
    agent: Agent,
    history: tuple[Message, ...],
    grounded_intent: bool,
    commerce_meaning: bool,
    interpretation: InterpretedRequest | InterpretationFailure | None,
    shopping_resume: ShoppingIntent | None,
    shopping_resume_revision: str | None,
    shopping_resume_question: ShoppingClarification | None,
) -> PreparedShopping | ShoppingAnswer:
    context_message = message
    if (
        isinstance(interpretation, InterpretedRequest)
        and "shoppingContext" in interpretation.entities
        and shopping_resume is None
    ):
        if interpretation.status != "RESOLVED" or interpretation.legacy_intent not in {
            "PRODUCT_SEARCH",
            "PRODUCT_RECOMMEND",
        }:
            return ShoppingAnswer(
                interpretation.message,
                Usage(0, 0, 0),
                "commerce-language-engine",
                catalog.calls,
            )
        try:
            context_message = contextual_message(
                verified_context(interpretation.entities["shoppingContext"], message),
                message,
            )
        except ValueError:
            return ShoppingAnswer(
                "Please clarify the product and its requirements.",
                Usage(0, 0, 0),
                "commerce-language-engine",
                catalog.calls,
            )
    if commerce_meaning:
        try:
            literal_frame = interpret(context_message, schema, history)
            if literal_frame.conflicts:
                meaning_summary(literal_frame, clarify(literal_frame))
                fields = ", ".join(
                    dict.fromkeys(c.field for c in literal_frame.conflicts)
                )
                return ShoppingAnswer(
                    f"Your requirements conflict for {fields}. Which value or range should I use?",
                    Usage(0, 0, 0),
                    "deterministic",
                    catalog.calls,
                )
            unsupported = {
                r.field
                for r in literal_frame.requirements
                if r.scope in {"basket", "delivery"}
            }
            if unsupported:
                return ShoppingAnswer(
                    "I cannot verify "
                    + ", ".join(sorted(unsupported))
                    + " with product search. Please use basket review or checkout to verify these requirements.",
                    Usage(0, 0, 0),
                    "deterministic",
                    catalog.calls,
                )
        except MeaningConflict as conflict:
            return ShoppingAnswer(
                str(conflict), Usage(0, 0, 0), "deterministic", catalog.calls
            )
    request = shopping_request(
        message,
        schema.model_dump_json(),
        agent,
        history,
        grounded_intent and english_query(message),
        output_schema=ShoppingIntent,
    )
    if isinstance(interpretation, InterpretationFailure):
        return ShoppingAnswer(
            "The language engine is unavailable. Please try again.",
            Usage(0, 0, 0),
            "commerce-language-engine",
            catalog.calls,
        )
    gate = interpretation
    revision_changed = bool(
        shopping_resume is not None
        and shopping_resume_revision
        and shopping_resume_revision != schema.version
    )
    resumed_frame = (
        shopping_resume_question.frame
        if revision_changed and shopping_resume_question is not None
        else shopping_resume
    )
    from app.commerce_action_engine.actions.catalog.workflow import (
        search_constraint_text,
    )

    plan_gate = gate
    plan_message = message
    if (
        gate is not None
        and resumed_frame is None
        and gate.legacy_intent in {"PRODUCT_SEARCH", "PRODUCT_RECOMMEND"}
    ):
        try:
            managed_numbers = numeric_constraints(
                search_constraint_text(gate.entities, message), schema
            )
            non_money_spans = tuple(span for _, span in managed_numbers) + tuple(
                (quantity.start, quantity.end)
                for quantity in quantity_comparisons(message)
            )
            # Validate customer monetary syntax even if malformed punctuation
            # prevents the flat language result from yielding a single plan.
            retain_price_bounds({}, message, ignore_spans=non_money_spans)
        except ValueError as error:
            return ShoppingAnswer(
                str(error),
                Usage(0, 0, 0),
                "commerce-language-engine",
                catalog.calls,
            )
        if non_money_spans:
            # Attribute measurements and quantity requirements are separate
            # from money. Rebuild limits only from remaining customer spans.
            plan_gate = gate.model_copy(
                update={
                    "entities": {
                        key: value
                        for key, value in gate.entities.items()
                        if key != "price"
                    }
                }
            )
            masked = list(message)
            for start, end in non_money_spans:
                masked[start:end] = " " * (end - start)
            plan_message = "".join(masked)
            from app.commerce_action_engine.actions.shopping.pricing import (
                _CURRENCY_NAMES,
                _MONEY,
            )

            money = {
                (
                    Decimal(match[2].replace(",", "")),
                    _CURRENCY_NAMES[normalized(match[1] or match[3])],
                )
                for match in re.finditer(_MONEY, plan_message, re.IGNORECASE)
                if match[1] or match[3]
            }
            price = gate.entities.get("price")
            remaining_numbers = {
                Decimal(match.group().replace(",", ""))
                for match in re.finditer(
                    r"(?<![\w.])\d+(?:,\d{3})*(?:\.\d+)?(?![\w.])", plan_message
                )
            } | {amount for amount, _ in money}
            try:
                literal_prices = retain_price_bounds({}, plan_message)
            except ValueError as error:
                return ShoppingAnswer(
                    str(error),
                    Usage(0, 0, 0),
                    "commerce-language-engine",
                    catalog.calls,
                )
            if isinstance(price, dict) and not literal_prices:

                def present_number(value: object) -> bool:
                    try:
                        return Decimal(str(value)) in remaining_numbers
                    except InvalidOperation:
                        return False

                restored = dict(price)
                if price.get("operator") == "BETWEEN":
                    low, high = (
                        present_number(price.get("min")),
                        present_number(price.get("max")),
                    )
                    if low != high:
                        restored = {
                            "operator": ">=" if low else "<=",
                            "value": price.get("min" if low else "max"),
                            "currency": price.get("currency"),
                        }
                    valid_money = low or high
                else:
                    valid_money = present_number(price.get("value"))
                if len(money) == 1:
                    _, currency = next(iter(money))
                    restored["currency"] = currency
                if valid_money:
                    plan_gate = gate.model_copy(
                        update={
                            "entities": {
                                **gate.entities,
                                "price": restored,
                            }
                        }
                    )
    gate_plan = (
        resumed_frame.model_copy(deep=True)
        if resumed_frame is not None
        else shopping_plan(plan_gate, plan_message)
        if plan_gate is not None
        else None
    )
    if revision_changed and gate_plan is not None:
        gate_plan.discovery_refined = False
    constraint_message = (
        search_constraint_text(gate.entities, message)
        if gate_plan is not None and gate is not None
        else message
    )
    if gate is not None and gate.status != "UNKNOWN" and gate_plan is None:
        return ShoppingAnswer(
            gate.message, Usage(0, 0, 0), "commerce-language-engine", catalog.calls
        )
    response = (
        ModelResponse(
            "", (), gate_plan, Usage(0, 0, 0), "commerce-language-engine", "stop"
        )
        if gate_plan is not None
        else await resolve_shopping(message, provider, request, catalog.planning)
    )

    plan = shopping_plan_from_response(response, ShoppingIntent)
    if gate_plan is None:
        plan.gift_context = None
        plan.shopping_context = None
    elif plan.shopping_context and shopping_resume is None:
        # Use only source-verified spans. The suggested coreText is diagnostic;
        # it cannot erase an independent price, allergy, or compatibility clause.
        message = constraint_message = context_message
    if plan.gift_context:
        message = constraint_message = plan.gift_context.core_text
    if shopping_resume is None:
        # IDs are bound only by runtime catalog evidence below.
        plan.category_id = None
        plan.required_product_ids = []
    # A grounded missing-evidence request stops before retrieval or recommendation.
    if gate_plan is not None and plan.clarification:
        return ShoppingAnswer(
            plan.clarification, response.usage, response.model, catalog.calls
        )
    if catalog.planning and gate_plan is not None:
        catalog.planning.accept_shopping_intent(message, plan)
    required_names = (
        refine_query(plan, message, schema, history)
        if grounded_intent and shopping_resume is None
        else []
    )
    if shopping_resume is None:
        personalization_restore(plan, message)
    # Generic catalog nouns do not constrain a product kind. Keep actual attributes hard.
    generic = {"product", "products", "item", "items"}
    if plan.category and normalized(plan.category) in generic:
        plan.category = None
    return PreparedShopping(
        message=message,
        constraint_message=constraint_message,
        response=response,
        plan=plan,
        gate=gate,
        interpreted=gate_plan is not None,
        required_names=tuple(required_names),
        revision_changed=revision_changed,
        resuming=shopping_resume is not None,
    )
