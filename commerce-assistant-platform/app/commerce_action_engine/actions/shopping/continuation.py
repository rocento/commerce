"""Compact catalog-derived active search state; never sent to the browser."""

import json
import re
from dataclasses import dataclass

from pydantic import Field

from app.commerce_action_engine.actions.catalog import DTO
from app.commerce_action_engine.actions.catalog.contracts import (
    CatalogProfile,
    CatalogSchema,
)

from .contracts import ShoppingChoice, ShoppingClarification, ShoppingIntent


class ActiveFacet(DTO):
    code: str = Field(min_length=1, max_length=64)
    label: str = Field(min_length=1, max_length=120)
    choices: list[ShoppingChoice] = Field(min_length=1, max_length=8)


class ActiveShopping(DTO):
    frame: ShoppingIntent
    descriptor_revision: str = Field(min_length=1, max_length=200)
    currency: str | None = Field(default=None, pattern=r"^[A-Z]{3}$")
    facets: list[ActiveFacet] = Field(default_factory=list, max_length=12)


def active_shopping(
    frame: ShoppingIntent,
    revision: str,
    profile: CatalogProfile | None,
    schema: CatalogSchema | None,
) -> ActiveShopping:
    # Values are current matching SKU observations; global declared options alone
    # cannot become an active reply allowlist. Classification/target changes must
    # go through ordinary fresh-request interpretation.
    known = (
        {attribute.code: attribute for attribute in schema.attributes} if schema else {}
    )
    facets = []
    if profile and profile.complete:
        for facet in profile.facets:
            attribute = known.get(facet.code)
            if attribute is None or attribute.semantic_role == "classification":
                continue
            choices = [
                ShoppingChoice(label=value.label, value=value.value)
                for value in facet.values
                if value.count > 0
                and len(str(value.value)) <= 100
                and len(value.label) > 0
            ][:8]
            if choices:
                facets.append(
                    ActiveFacet(
                        code=facet.code,
                        label=facet.label or facet.code,
                        choices=choices,
                    )
                )
            if len(facets) == 12:
                break
    currency = frame.currency
    if (
        currency is None
        and profile
        and profile.complete
        and len(profile.prices) == 1
        and profile.prices[0].count == profile.matched_count
    ):
        currency = profile.prices[0].currency
    state = ActiveShopping(
        frame=frame,
        descriptor_revision=revision,
        currency=currency,
        facets=facets,
    )
    # Leave room for the original message and JSONB formatting overhead in the
    # persisted 32 KiB state. Drop optional reply choices, never request facts.
    while (
        state.facets
        and len(json.dumps(state.model_dump(mode="json")).encode("utf-8")) > 23000
    ):
        state.facets.pop()
    return state


@dataclass(frozen=True)
class ActiveReply:
    frame: ShoppingIntent | None = None
    question: ShoppingClarification | None = None
    plan: ShoppingClarification | None = None
    error: str | None = None


def resolve_active_reply(state: ActiveShopping, reply: str) -> ActiveReply:
    from app.commerce_action_engine.actions.shopping.pricing import (
        _BOUND,
        _MONEY,
        _RANGE,
    )
    from app.commerce_action_engine.execution.language.shopping_reply import (
        choice_text,
        is_fresh_request,
        resolve_shopping_reply,
    )

    if is_fresh_request(reply):
        return ActiveReply()
    answer = reply.strip().casefold()
    matches = [
        (facet, choice)
        for facet in state.facets
        for choice in facet.choices
        if answer in {choice.label.casefold(), choice_text(choice.value).casefold()}
    ]
    # Identical labels in one field can still map to different typed values.
    unique = {(facet.code, choice_text(choice.value)) for facet, choice in matches}
    if len(unique) > 1:
        choices: list[ShoppingChoice] = []
        seen = set()
        for facet, choice in matches:
            key = (facet.code, choice_text(choice.value))
            if key in seen:
                continue
            seen.add(key)
            label = f"{facet.label}: {choice.label}"[:115]
            if any(item.label.casefold() == label.casefold() for item in choices):
                label += f" ({len(choices) + 1})"
            choices.append(
                ShoppingChoice(
                    label=label,
                    value=choice.value,
                    field=facet.code,
                )
            )
        question = ShoppingClarification(
            question="Which product feature did you mean?",
            field="attribute",
            choices=choices[:8],
            frame=state.frame,
            descriptor_revision=state.descriptor_revision,
            optional=False,
            currency=state.currency,
        )
        return ActiveReply(question=question)
    selected_facet = matches[0][0] if len(unique) == 1 else None
    selected_choice = matches[0][1] if len(unique) == 1 else None
    plan = ShoppingClarification(
        question="What is your budget?",
        field=selected_facet.code if selected_facet else "budget",
        choices=[selected_choice] if selected_choice else [],
        frame=state.frame,
        descriptor_revision=state.descriptor_revision,
        optional=False,
        currency=state.currency,
    )
    result = resolve_shopping_reply(plan, reply)
    is_budget = bool(
        _BOUND.fullmatch(reply.strip())
        or _RANGE.fullmatch(reply.strip())
        or re.fullmatch(_MONEY, reply.strip(), re.IGNORECASE)
    )
    return ActiveReply(
        frame=result.frame,
        plan=plan if result.frame else None,
        error=result.error if matches or is_budget else None,
    )
