"""Basket proposal workflow; commerce remains authoritative for basket state."""

import re
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal
from uuid import UUID

from app.commerce_action_engine.actions.catalog import (
    DTO,
    CatalogResult,
    CatalogSchema,
    SchemaArgs,
    SearchAttribute,
    SearchToolArgs,
)
from app.commerce_action_engine.actions.catalog import labels as discovery_labels
from app.commerce_action_engine.actions.shopping.basket_ports import BasketGateway
from app.commerce_action_engine.actions.shopping.baskets import (
    BasketPlan,
    preserve_product_locks,
)
from app.commerce_action_engine.actions.shopping.constraints import (
    numeric_constraints,
    preserve_schema_constraints,
    structured_filters,
)
from app.commerce_action_engine.actions.shopping.contracts import Constraint
from app.commerce_action_engine.actions.shopping.meaning import MeaningConflict
from app.commerce_action_engine.actions.shopping.personalization import (
    reasons as personalization_reasons,
)
from app.commerce_action_engine.actions.shopping.pricing import (
    PriceBound,
    iter_price_bounds,
    retain_price_bounds,
)
from app.commerce_action_engine.actions.shopping.quantity_language import (
    quantity_comparisons,
)
from app.commerce_action_engine.actions.shopping.selection import select
from app.commerce_action_engine.contracts import AssistantBlock
from app.commerce_action_engine.execution.agents import Principal
from app.commerce_action_engine.execution.core.meaning import (
    Clarification,
    ConstraintFrame,
)
from app.commerce_action_engine.execution.core.policy import PolicyDecision
from app.commerce_action_engine.shared.errors import RuntimeErrorCode, ToolUnavailable
from app.commerce_contracts.comparisons import comparison_pattern, intersect_bound
from app.commerce_resolution_engine.basket import resolve_basket
from app.commerce_resolution_engine.contracts import (
    ModelProvider,
)
from app.commerce_resolution_engine.runtime import RuntimeTool


@dataclass(frozen=True, slots=True)
class _ScopedPrice:
    bound: PriceBound
    scope: Literal["basket", "item", "ambiguous"]
    lines: frozenset[int] = frozenset()


def _mask_money(message: str, bounds: list[PriceBound] | tuple[PriceBound, ...]) -> str:
    masked = list(message)
    for bound in bounds:
        masked[bound.start : bound.end] = " " * (bound.end - bound.start)
    return "".join(masked)


def _nonmoney_spans(message: str, schema: CatalogSchema) -> tuple[tuple[int, int], ...]:
    # Number comparisons in a schema measurement or quantity are not spending
    # limits. The money reader deliberately leaves this binding to the consumer.
    ignored = [span for _, span in numeric_constraints(message, schema)]
    ignored.extend((row.start, row.end) for row in quantity_comparisons(message))
    return tuple(ignored)


def _price_bounds(message: str, schema: CatalogSchema) -> tuple[PriceBound, ...]:
    return tuple(
        sorted(
            (
                *iter_price_bounds(
                    message, ignore_spans=_nonmoney_spans(message, schema)
                ),
                *_labelled_budget_bounds(message),
            ),
            key=lambda bound: (bound.start, bound.end),
        )
    )


def _scope_prices(
    message: str,
    bounds: tuple[PriceBound, ...],
    plan: BasketPlan,
    previous: dict[str, Any],
    schema: CatalogSchema,
) -> list[_ScopedPrice]:
    """Bind source spans to totals or line prices without trusting model scope."""
    rows = []
    for bound in bounds:
        start = max(
            (
                match.end()
                for match in re.finditer(
                    r"[;!?]|(?<!\d)[,.]|[,.](?!\d)", message[: bound.start]
                )
            ),
            default=0,
        )
        prefix, suffix = message[start : bound.start], message[bound.end :]
        cues: list[tuple[int, Literal["basket", "item"], frozenset[int]]] = []
        for match in re.finditer(
            r"\b(?:basket|cart|total|overall|budget|spending limit|spend)\b",
            prefix,
            re.IGNORECASE,
        ):
            cues.append((match.end(), "basket", frozenset()))
        for match in re.finditer(
            r"\b(?:each|per (?:item|product|unit)|(?:item|product|unit|line) price)\b",
            prefix,
            re.IGNORECASE,
        ):
            cues.append((match.end(), "item", frozenset(range(len(plan.searches)))))
        for index, line in enumerate(plan.searches):
            query = line.intent.query.strip()
            query = _mask_money(query, _price_bounds(query, schema)).strip()
            if not query or query.casefold() in {
                "*",
                "product",
                "products",
                "item",
                "items",
                "basket",
                "cart",
            }:
                continue
            for match in re.finditer(
                r"(?<!\w)" + re.escape(query) + r"(?!\w)", prefix, re.IGNORECASE
            ):
                cues.append((match.end(), "item", frozenset({index})))
        scope: Literal["basket", "item", "ambiguous"] = "ambiguous"
        lines = frozenset[int]()
        if cues:
            _, scope, lines = max(cues, key=lambda cue: cue[0])
        if re.match(
            r"\b(?:budget|spending limit|can spend)\b",
            message[bound.start : bound.end],
            re.IGNORECASE,
        ):
            scope, lines = "basket", frozenset()
        # A trailing explicit scope belongs to this amount, not a later clause.
        if re.match(r"\s*(?:each|per (?:item|product|unit))\b", suffix, re.IGNORECASE):
            scope = "item"
            if not lines:
                lines = frozenset(range(len(plan.searches)))
        elif re.match(
            r"\s*(?:in total|total|for (?:the |this )?(?:basket|cart))\b",
            suffix,
            re.IGNORECASE,
        ):
            scope, lines = "basket", frozenset()
        elif not cues and (
            re.fullmatch(r"\s*(?:(?:make|keep)\s+it\s+)?", prefix, re.IGNORECASE)
            or re.match(r"\s*(?:build|plan|prepare|make)\b", prefix, re.IGNORECASE)
        ):
            # Existing whole-task shorthand and bare budget refinements remain
            # supported; product-bound phrases above never take this fallback.
            scope = "basket"
        elif (
            not cues
            and previous.get("budget")
            and re.fullmatch(
                r"\s*(?:now|instead|change (?:it|the limit) to)\s*",
                prefix,
                re.IGNORECASE,
            )
        ):
            scope = "basket"
        rows.append(_ScopedPrice(bound, scope, lines))
    return rows


def _labelled_budget_bounds(message: str) -> list[PriceBound]:
    """Retain directly stated budgets through the shared monetary reader."""
    quoted = [match.span() for match in re.finditer(r'"[^"\n]*"|“[^”\n]*”', message)]
    rows = []
    for cue in re.finditer(
        r"\b(?:budget(?:\s+(?:is|of))?|spending limit(?:\s+(?:is|of))?|can spend)\s*[:=]?\s*",
        message,
        re.IGNORECASE,
    ):
        if any(start < cue.end() and cue.start() < end for start, end in quoted):
            continue
        comparison = "at most "
        monetary_text = comparison + message[cue.end() :]
        later = next(
            (
                match.start()
                for match in re.finditer(
                    rf"\b(?:{comparison_pattern()}|between)\b",
                    monetary_text,
                    re.IGNORECASE,
                )
                if match.start() > 0
            ),
            len(monetary_text),
        )
        try:
            bounds = iter_price_bounds(
                monetary_text, ignore_spans=((later, len(monetary_text)),)
            )
        except ValueError as error:
            raise ValueError(
                "Please give the basket budget as a complete monetary amount and currency."
            ) from error
        if not bounds or bounds[0].start != 0:
            if re.match(r"[A-Z]{3}\s*\d", message[cue.end() :]):
                raise ValueError(
                    "Please give the basket budget in a supported currency."
                )
            continue
        bound = bounds[0]
        end = cue.end() + bound.end - len(comparison)
        if any(start < end and cue.start() < stop for start, stop in quoted):
            continue
        remainder = message[end:]
        if re.match(r"\w", remainder):
            raise ValueError("Please give the basket budget as a monetary amount.")
        word = re.match(r"\s+([A-Za-z]+)\b", remainder)
        if word and word[1].casefold() in {
            "gb",
            "tb",
            "mb",
            "kg",
            "g",
            "l",
            "ml",
            "piece",
            "pieces",
            "items",
        }:
            raise ValueError("Please give the basket budget as a monetary amount.")
        if (
            word
            and not bound.currency
            and word[1].casefold()
            not in {
                "and",
                "or",
                "for",
                "including",
                "excluding",
                "with",
                "without",
                "merchandise",
                "basket",
                "cart",
                "total",
                "all",
            }
        ):
            raise ValueError("Please give the basket budget in a supported currency.")
        if re.search(r"\b(?:not|never|no)\s*$", message[: cue.start()], re.IGNORECASE):
            raise ValueError("Please clarify the negated basket budget.")
        rows.append(PriceBound(cue.start(), end, "lte", bound.amount, bound.currency))
    return rows


def _retain_budget(
    plan: BasketPlan,
    message: str,
    prices: list[_ScopedPrice],
    previous: dict[str, Any],
    currency: str,
) -> None:
    basket = [row.bound for row in prices if row.scope == "basket"]
    ambiguous = any(row.scope == "ambiguous" for row in prices)
    if ambiguous:
        plan.goal.unresolved.append(
            "Does the price limit apply to each item or to the whole basket?"
        )
    currencies = {bound.currency for bound in basket if bound.currency}
    unsupported = any(bound.operator not in {"lt", "lte"} for bound in basket)
    if len(currencies) > 1:
        plan.goal.unresolved.append("Please use one currency for the basket budget.")
    if unsupported:
        plan.goal.unresolved.append(
            "Basket budgets support an upper spending limit. Please give the maximum total budget."
        )
    if basket and not ambiguous and not unsupported and len(currencies) <= 1:
        budget, exclusive = None, False
        for bound in basket:
            budget, exclusive = intersect_bound(
                budget, exclusive, bound.amount, bound.operator == "lt", "max"
            )
        plan.goal.budget, plan.goal.budget_exclusive = budget, exclusive
        plan.goal.currency = next(
            iter(currencies), previous.get("currency") or currency
        )
    elif previous.get("budget"):
        plan.goal.budget = previous["budget"]
        plan.goal.currency = previous.get("currency")
        plan.goal.budget_exclusive = previous.get("budget_exclusive", False)
    else:
        # Quantities, context cart prices and item prices cannot become a total
        # budget just because the provider repeats their numeric amount.
        plan.goal.budget = None
        plan.goal.budget_exclusive = False
    if previous.get("budget") and not re.search(
        r"\b(?:including|includes|exclude|excluding|inclusive|delivery|fees|merchandise)\b",
        message,
        re.IGNORECASE,
    ):
        plan.goal.all_inclusive = previous.get("all_inclusive", False)


async def plan_basket(
    message: str,
    mode: str,
    task: UUID,
    provider: ModelProvider,
    catalog: dict[str, RuntimeTool],
    principal: Principal,
    baskets: BasketGateway,
    commerce_meaning: bool = False,
    commerce_planning: bool = False,
    planning_prices: tuple[int, int] | None = None,
    *,
    record_meaning: Callable[[ConstraintFrame, Clarification], None] | None = None,
    record_planning: Callable[[dict[str, object]], None] | None = None,
    record_policy: Callable[[PolicyDecision], None] | None = None,
    record_execution: Callable[[dict[str, object]], None] | None = None,
) -> tuple[str, list[AssistantBlock]]:
    from app.commerce_action_engine.actions.shopping.meaning import (
        apply_meaning,
        assess_action,
        interpret,
        verified_products,
    )
    from app.commerce_action_engine.execution.language.shopping import english_query

    commerce_meaning = commerce_meaning and english_query(message)
    if commerce_meaning:
        # The future cart step is assessed explicitly; a proposal never consumes confirmation.
        policy = assess_action(principal, "cart_apply", request_id=str(task))
        if record_policy is not None:
            record_policy(policy)
    from app.commerce_action_engine.execution.planning import (
        LocalReceipt,
        start_planning,
    )
    from app.commerce_action_engine.execution.planning.library import (
        ProposalReceipt,
        TaskInput,
    )

    planning = start_planning(
        commerce_planning and english_query(message),
        mode.replace("_", "-"),
        principal,
        catalog,
        basket=True,
        prices=planning_prices,
        record_planning=record_planning,
    )
    context = (
        await planning.perform(
            "basket.context",
            TaskInput(task_id=str(task)),
            lambda: baskets.context(task),
            lambda _: LocalReceipt(status="checked"),
        )
        if planning
        else await baskets.context(task)
    )
    if context["cancelled"]:
        return "This shopping task was cancelled. Start a new task to continue.", []
    if mode == "buy_again":
        return (
            "Choose an order using Buy again. Its current products and prices will be quoted before you approve any cart update.",
            [],
        )
    calls = 0

    async def call(name: str, arguments: DTO) -> CatalogResult:
        nonlocal calls
        calls += 1
        if calls > 6 or name not in catalog:
            raise RuntimeErrorCode("tool_not_allowed")
        tool = catalog[name]
        validated = tool.definition.arguments.model_validate(
            arguments.model_dump(), strict=True
        )
        result = (
            await planning.perform(
                "catalog." + name,
                validated,
                lambda: tool.handler(validated, principal),
                lambda value: value,
            )
            if planning
            else await tool.handler(validated, principal)
        )
        return CatalogResult.model_validate_json(result.model_dump_json())

    schema = (await call("get_catalog_schema", SchemaArgs())).catalog_schema
    if schema is None:
        raise ToolUnavailable()
    if planning:
        planning.discover_industry(
            schema.industry, tuple(a.code for a in schema.attributes)
        )
    try:
        price_bounds = _price_bounds(message, schema)
    except ValueError as error:
        return str(error), []
    if commerce_meaning:
        try:
            # Monetary comparisons cannot be merged across separate item and
            # basket scopes. Their conflicts are checked after scope binding.
            goal_frame = interpret(_mask_money(message, price_bounds), schema)
        except MeaningConflict as conflict:
            return str(conflict), []
        if goal_frame.conflicts:
            fields = ", ".join(dict.fromkeys(c.field for c in goal_frame.conflicts))
            return (
                f"Your requirements conflict for {fields}. Which value or range should I use?",
                [],
            )
    previous = context.get("draft") or {}
    items = context["cart"]["items"]
    plan = await resolve_basket(
        message,
        mode,
        context,
        schema.model_dump(mode="json"),
        provider,
        planning,
        output_schema=BasketPlan,
    )
    if planning:
        planning.compose_basket(len(plan.searches))
    known_ids = {i["product_id"] for i in items} | {
        s["product_id"] for s in previous.get("selections", [])
    }
    if any(i not in known_ids for i in plan.goal.locked_products):
        raise RuntimeErrorCode("invalid_reference")
    old_goal = previous.get("goal", {})
    preserve_product_locks(plan, message, old_goal.get("locked_products", []))
    plan.goal.excluded_products = sorted(
        set(plan.goal.excluded_products) | set(old_goal.get("excluded_products", []))
    )
    plan.goal.locked_brands = sorted(
        set(plan.goal.locked_brands) | set(old_goal.get("locked_brands", []))
    )
    try:
        prices = _scope_prices(message, price_bounds, plan, old_goal, schema)
        _retain_budget(plan, message, prices, old_goal, context["cart"]["currency"])
    except ValueError as error:
        return str(error), []
    if plan.clarification:
        plan.goal.unresolved.append(plan.clarification)
    if plan.goal.people:
        plan.goal.assumptions.append(
            "Quantities are editable suggestions for the stated number of people, not verified serving sizes."
        )
    selections = list(previous.get("selections", [])) if mode == "shop" else []
    for edit in plan.quantities:
        if edit.product_id not in {s["product_id"] for s in selections} and any(
            i["product_id"] == edit.product_id and i["quantity"] == edit.quantity
            for i in items
        ):
            # Echoing an unchanged live quantity is not a requested edit or a conflict.
            continue
        if mode != "shop" or edit.product_id in plan.goal.locked_products:
            plan.goal.unresolved.append(
                "A quantity edit conflicts with a locked product or the requirement to preserve cart quantities."
            )
            continue
        existing = next(
            (s for s in selections if s["product_id"] == edit.product_id), None
        )
        if existing is None:
            raise RuntimeErrorCode("invalid_reference")
        existing["quantity"] = edit.quantity
    for index, requested in enumerate(plan.searches if mode == "shop" else []):
        if requested.replace_proposed and (
            requested.replace_proposed not in {s["product_id"] for s in selections}
            or requested.replace_proposed in plan.goal.locked_products
        ):
            plan.goal.unresolved.append(
                "The requested replacement conflicts with a locked or unknown product."
            )
            continue
        intent = requested.intent
        if intent.clarification:
            plan.goal.unresolved.append(intent.clarification)
            continue
        if intent.brand:
            definitions = [
                d
                for d in schema.attributes
                if d.semantic_role == "brand" and d.filterable
            ]
            if len(definitions) == 1:
                intent.attributes.append(
                    Constraint(name=definitions[0].code, value=intent.brand)
                )
                intent.brand = None
            else:
                plan.goal.unresolved.append(
                    "The requested brand cannot be verified using the catalog schema."
                )
                continue
        intent.in_stock = True
        intent.currency = plan.goal.currency or context["cart"]["currency"]
        meaning = None
        try:
            item_bounds = [
                row.bound
                for row in prices
                if row.scope == "item" and index in row.lines
            ]
            other_bounds = [bound for bound in price_bounds if bound not in item_bounds]
            item_message = _mask_money(message, other_bounds)
            # Remove an extraction echo of another domain's number. Existing
            # independent model line limits are retained as before.
            other_amounts = {Decimal(bound.amount) for bound in other_bounds}
            for direction in ("min", "max"):
                field, flag = f"{direction}_price", f"exclusive_{direction}"
                amount = getattr(intent, field)
                if amount is not None and Decimal(amount) in other_amounts:
                    setattr(intent, field, None)
                    setattr(intent, flag, False)
            retained = retain_price_bounds(
                {
                    field: getattr(intent, field)
                    for field in (
                        "min_price",
                        "max_price",
                        "exclusive_min",
                        "exclusive_max",
                        "currency",
                    )
                },
                item_message,
                literal_ties=True,
                ignore_spans=_nonmoney_spans(item_message, schema),
            )
            for field, value in retained.items():
                setattr(intent, field, value)
            if intent.currency != (plan.goal.currency or context["cart"]["currency"]):
                plan.goal.unresolved.append(
                    "Please use the basket currency for each item's price limit."
                )
                continue
            if commerce_meaning:
                meaning = apply_meaning(
                    intent, item_message, schema, record_meaning=record_meaning
                )
            else:
                intent.attributes = preserve_schema_constraints(
                    item_message, intent.attributes, schema
                )
            filters = structured_filters(intent.attributes, schema)
        except MeaningConflict as conflict:
            plan.goal.unresolved.append(str(conflict))
            continue
        except ValueError:
            plan.goal.unresolved.append(
                "A required attribute is unsupported or ambiguous. Please clarify it."
            )
            continue
        from .pricing import empty_price_range

        if empty_price_range(intent):
            plan.goal.unresolved.append(
                "Please clarify the item's price range; no price can satisfy both limits."
            )
            continue
        result = await call(
            "search_products",
            SearchToolArgs(
                query=intent.query or "*",
                attributes=[
                    SearchAttribute(name=name, value=value)
                    for name, value in filters.items()
                ],
                min_price=intent.min_price,
                max_price=intent.max_price,
                exclusive_min=intent.exclusive_min,
                exclusive_max=intent.exclusive_max,
                currency=intent.currency,
                in_stock=True,
            ),
        )
        if meaning is not None:
            result.products = verified_products(result.products, meaning)
        exact, _ = (
            planning.rank(result.products, intent, None)
            if planning
            else select(result.products, intent, None)
        )
        candidates = [
            p for p, _ in exact if str(p.id) not in plan.goal.excluded_products
        ]
        if not candidates:
            plan.goal.unresolved.append(
                f"No verified match among checked candidates for {intent.query}."
            )
            continue
        p = candidates[0]
        if requested.replace_proposed:
            selections = [
                s for s in selections if s["product_id"] != requested.replace_proposed
            ]
        if any(s["product_id"] == str(p.id) for s in selections):
            plan.goal.unresolved.append(
                f"{p.name} is already proposed. Edit its quantity explicitly."
            )
            continue
        selections.append(
            {
                "product_id": str(p.id),
                "quantity": requested.quantity,
                "replaces": None,
                "min_price": intent.min_price,
                "max_price": intent.max_price,
                "exclusive_max": intent.exclusive_max,
                "exclusive_min": intent.exclusive_min,
                "required_attributes": filters,
                "reason": " ".join(
                    [
                        "Matches the checked catalog constraints. Review the selected SKU and quantity.",
                        *discovery_labels(p.discovery),
                        *personalization_reasons(p),
                    ]
                ).strip(),
            }
        )
    draft = {
        "task_id": str(task),
        "task_revision": context["task_revision"],
        "source_revision": context["source_revision"],
        "mode": mode,
        "auto_select": mode == "optimize",
        "goal": plan.goal.model_dump(),
        "location_id": previous.get("location_id")
        or next(
            (l["id"] for l in context.get("locations", []) if l.get("is_default")), None
        ),
        "order_id": None,
        "selections": selections,
    }
    proposal = (
        await planning.perform(
            "basket.quote",
            plan,
            lambda: baskets.quote(task, draft),
            lambda value: ProposalReceipt(id=value["id"], can_apply=value["can_apply"]),
        )
        if planning
        else await baskets.quote(task, draft)
    )
    from app.commerce_action_engine.execution.planning.execution import verify_receipt

    receipt = verify_receipt(
        proposal, task, mode, required=context.get("execution_enabled", False)
    )
    if receipt and record_execution is not None:
        record_execution(receipt.model_dump(mode="json"))
    proposal_id = UUID(proposal["id"])
    text = (
        "Your proposed basket is ready to review. Your live cart has not changed."
        if proposal["can_apply"]
        else "Review the proposed basket and unresolved constraints below. Your live cart has not changed."
    )
    return text, [
        AssistantBlock(kind="text", text=text),
        AssistantBlock(kind="basket_proposal", proposal_id=proposal_id),
    ]
