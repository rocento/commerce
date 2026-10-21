"""Assemble shopping replies and evidence-backed product cards."""

from dataclasses import dataclass

from app.commerce_action_engine.actions.catalog import (
    CatalogProfile,
    CatalogSchema,
)
from app.commerce_action_engine.actions.catalog import labels as discovery_labels
from app.commerce_action_engine.actions.catalog.workflow import broad_value_request
from app.commerce_action_engine.actions.shopping.constraints import (
    matches_attribute,
)
from app.commerce_action_engine.actions.shopping.context import (
    consume_response_preference,
    context_note,
    response_preferences,
    response_product_limit,
)
from app.commerce_action_engine.actions.shopping.contracts import (
    Constraint,
    ShoppingClarification,
    ShoppingIntent,
)
from app.commerce_action_engine.actions.shopping.evidence import attribute_evidence
from app.commerce_action_engine.actions.shopping.personalization import (
    reasons as personalization_reasons,
)
from app.commerce_action_engine.actions.shopping.personalization import (
    remember as personalization_remember,
)
from app.commerce_action_engine.actions.shopping.recommendations import (
    diversify_purpose_groups,
)
from app.commerce_action_engine.actions.shopping.selection import select
from app.commerce_action_engine.application.responses import card, catalog_block, finish
from app.commerce_action_engine.application.shopping_presentation import (
    constraint_text,
    narrowing_question,
    plain,
    render,
    shopping_no_match,
)
from app.commerce_action_engine.contracts import AssistantBlock
from app.commerce_action_engine.contracts.interpretation import (
    InterpretedRequest,
)
from app.commerce_action_engine.shared.errors import RuntimeErrorCode
from app.commerce_resolution_engine.contracts import (
    ModelResponse,
)

from .catalog import ShoppingCatalog
from .contracts import (
    GroundedShopping,
    PreparedShopping,
    ReferenceSelection,
    RetrievedShopping,
    ShoppingAnswer,
)


@dataclass(frozen=True)
class ShoppingResponder:
    response: ModelResponse
    gate: InterpretedRequest | None
    interpreted: bool
    max_output_characters: int

    def build(
        self,
        text: str,
        blocks: tuple[AssistantBlock, ...] = (),
        *,
        plan: ShoppingIntent,
        schema: CatalogSchema,
        calls: int,
        active_profile: CatalogProfile | None = None,
        clarification: str | None = None,
        verified_read: bool = False,
        pending_shopping: ShoppingClarification | None = None,
    ) -> ShoppingAnswer:
        if (
            self.interpreted
            and self.gate is not None
            and self.gate.legacy_intent in {"ADD_TO_CART", "ADD_TO_WISHLIST"}
            and blocks
        ):
            quantity = self.gate.entities.get("quantity", 1)
            if self.gate.legacy_intent == "ADD_TO_WISHLIST":
                text = (
                    "Choose the matching product below and save it with the wishlist control. Your wishlist has not been changed.\n\n"
                    + text
                )
            else:
                text = (
                    f"Choose the matching product below and add {quantity} using its cart controls. Your cart has not been changed.\n\n"
                    + text
                )
        if len(text) > self.max_output_characters:
            raise RuntimeErrorCode("output_limit")
        evidence = (
            "read_result"
            if verified_read
            and (
                self.gate is None
                or self.gate.legacy_intent not in {"ADD_TO_CART", "ADD_TO_WISHLIST"}
            )
            else None
        )
        return ShoppingAnswer(
            text,
            self.response.usage,
            self.response.model,
            calls,
            blocks,
            clarification,
            evidence,
            pending_shopping,
            plan.model_copy(deep=True),
            schema.version,
            active_profile,
            schema,
        )


def present_shopping(
    prepared: PreparedShopping,
    grounded: GroundedShopping,
    references: ReferenceSelection,
    retrieved: RetrievedShopping,
    *,
    catalog: ShoppingCatalog,
    responder: ShoppingResponder,
) -> ShoppingAnswer:
    plan, schema = references.plan, grounded.schema
    reference = references.product
    result, groups = retrieved.result, list(retrieved.groups)
    message = prepared.message
    active_profile = result.catalog_profile

    def answer(
        text: str,
        blocks: tuple[AssistantBlock, ...] = (),
        *,
        clarification: str | None = None,
        verified_read: bool = False,
        pending_shopping: ShoppingClarification | None = None,
    ) -> ShoppingAnswer:
        return responder.build(
            text,
            blocks,
            plan=plan,
            schema=schema,
            calls=catalog.calls,
            clarification=clarification,
            verified_read=verified_read,
            pending_shopping=pending_shopping,
            active_profile=active_profile,
        )

    exact, alternatives = (
        catalog.planning.rank(result.products, plan, reference)
        if catalog.planning
        else select(result.products, plan, reference)
    )
    exact = diversify_purpose_groups(exact, groups)
    if (
        not exact
        and plan.currency
        and grounded.default_currency
        and plan.currency != grounded.default_currency
        and (plan.max_price is not None or plan.min_price is not None)
    ):
        # A default is not proof that other currencies are unavailable. Only
        # explain the mismatch after searching in the requested currency.
        text = (
            f"Your budget is in {plan.currency}, while this store’s default "
            f"currency is {grounded.default_currency}. I couldn’t find matching "
            f"products priced in {plan.currency}. I haven’t converted your budget. "
            f"What budget would you like to use in {grounded.default_currency}?"
        )
        return answer(
            text,
            (AssistantBlock(kind="text", text=text),),
            pending_shopping=ShoppingClarification(
                question=text,
                field="currency_budget",
                frame=plan.model_copy(deep=True),
                descriptor_revision=schema.version,
                optional=False,
                currency=grounded.default_currency,
            ),
            verified_read=True,
        )
    if "one_question" in response_preferences(plan):
        text = narrowing_question(plan, has_matches=bool(exact))
        question = ShoppingClarification(
            question=text,
            field="replacement_budget",
            frame=consume_response_preference(plan, "one_question"),
            descriptor_revision=schema.version,
            optional=False,
            currency=plan.currency,
        )
        return answer(
            text,
            (AssistantBlock(kind="text", text=text),),
            verified_read=True,
            pending_shopping=question,
        )
    selected = (exact or alternatives)[: response_product_limit(plan, default=8)]
    personalization_remember(plan, [p for p, _ in exact[:5]])
    cards = []
    for product, failures in selected:
        reasons = discovery_labels(product.discovery) + personalization_reasons(product)
        constraints = list(plan.attributes) + list(plan.preferences)
        if plan.brand:
            constraints.append(Constraint(name="brand", value=plan.brand))
        if plan.intended_use:
            constraints.append(Constraint(name="intended_use", value=plan.intended_use))
        for constraint in constraints:
            if matches_attribute(product, constraint):
                sources = ", ".join(
                    attribute_evidence(
                        product, constraint.name, constraint.value
                    ).sources
                )
                reasons.append(
                    f"Catalog lists {constraint.name}: {constraint.value} (source: {sources})"
                    if constraint.operator in {"eq", "contains"}
                    else f"Meets {constraint_text(constraint)} (source: {sources})"
                )
        if plan.max_price and "maximum budget" not in failures:
            reasons.append(
                f"Within your maximum budget: {product.price} {product.currency}"
            )
        if reference and not failures:
            reasons.append(
                f"Lower current price than the reference: {reference.price} {reference.currency}"
            )
        if not reasons:
            reasons.append(f"Current catalog price: {product.price} {product.currency}")
        cards.append(card(product, reasons, failures))
    blocks = (
        [
            catalog_block(
                "product_list"
                if plan.presentation == "search"
                else "recommendation_group",
                cards,
                (
                    "Lowest-priced matches checked — grouped by currency"
                    if plan.sort_by == "price_asc"
                    else "Highest-priced matches checked — grouped by currency"
                    if plan.sort_by == "price_desc"
                    else "Gift ideas from this store"
                    if plan.gift_context
                    else "Matches to your requirements"
                )
                if exact
                else "Alternatives — unmet requirements shown",
            )
        ]
        if cards
        else [
            AssistantBlock(
                kind="text",
                text=shopping_no_match(plan, result.discovery),
            )
        ]
    )
    if plan.intended_use:
        blocks.append(
            AssistantBlock(
                kind="text",
                text=f"Suitability for {plain(plan.intended_use)} is only verified where the catalog explicitly lists that intended use.",
            )
        )
    text = render(result.products, plan, reference)
    note = context_note(plan)
    if note and cards:
        blocks.append(AssistantBlock(kind="text", text=note))
        text += "\n\n" + note
    if prepared.interpreted and broad_value_request(message) and exact:
        text = (
            "To get you started, here are in-stock options with lower purchase prices "
            "among the products checked, grouped by currency. "
            "This compares listed prices, not price per unit or product quality.\n\n"
            + text
            + "\nTell me a product type or budget to narrow these suggestions."
        )
    if not exact:
        text = text.replace(
            shopping_no_match(plan),
            shopping_no_match(plan, result.discovery),
            1,
        )
    return answer(
        text,
        finish(blocks, browse_catalog=plan.presentation != "recommend"),
        verified_read=True,
    )
