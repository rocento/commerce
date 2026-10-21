"""Deterministic preservation policy for standard language proposals."""

import re
from collections import Counter

from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.execution.language.handoffs import (
    CONTEXT_INTENTS,
    HANDOFFS,
)
from app.commerce_action_engine.execution.language.proposal_constraints import (
    asks_about_action,
    preserves_entities,
    preserves_literals,
)
from app.commerce_action_engine.execution.language.routing import (
    ASSISTANT_API_INTENTS,
    CART_ACTION_INTENTS,
    CONFIRMATION_CONTEXT_INTENTS,
    route,
)
from app.commerce_contracts.language_proposal import (
    LanguageProposal,
)

PROPOSABLE_INTENTS = (
    ASSISTANT_API_INTENTS
    | CART_ACTION_INTENTS
    | HANDOFFS.keys()
    | CONTEXT_INTENTS
    | {"REORDER", "CANCEL_ORDER", "RETURN_ITEM"}
)

# Conditional wording is never permission for these write/review workflows.
# Keep this set shared with action-question checks instead of independently
# deciding whether a newly proposed intent may change shopper state.
_WRITE_PROPOSAL_INTENTS = (
    CART_ACTION_INTENTS
    | CONFIRMATION_CONTEXT_INTENTS
    | {"REORDER", "CANCEL_ORDER", "RETURN_ITEM", "REMOVE_FROM_WISHLIST"}
)

# UNKNOWN reference recovery is read-only; previous wording cannot authorize writes.
CONTEXTUAL_READ_INTENTS = frozenset(
    {
        "PRODUCT_SEARCH",
        "PRODUCT_RECOMMEND",
        "PRODUCT_COMPARE",
        "VIEW_CART",
        "CART_TOTAL",
        "CART_ITEM_COUNT",
        "VIEW_WISHLIST",
        "ORDER_HISTORY",
        "ORDER_DETAILS",
        "ORDER_STATUS",
        "TRACK_ORDER",
        "DELIVERY_STATUS",
        "ACCOUNT_ADDRESS_LIST",
        "SUPPORT_TICKET_STATUS",
        "SUPPORT_CHAT_HISTORY",
    }
)


def _numbers(text: str) -> Counter[str]:
    # Preserve signs, fractions and bounds verbatim; the model must not repair an
    # invalid quantity, insert an order number, or silently remove a price limit.
    return Counter(
        re.findall(
            r"(?<!\w)[+-]?\d+(?:[.,]\d+)*(?!\w)|"
            r"\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|"
            r"thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|"
            r"thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|"
            r"dozen|half|quarter|couple|minus|negative)\b",
            text.casefold(),
        )
    )


def _literal(value: str, message: str) -> bool:
    value, message = (" ".join(text.casefold().split()) for text in (value, message))
    return re.search(r"(?<!\w)" + re.escape(value) + r"(?!\w)", message) is not None


def _qualifiers(text: str) -> set[str]:
    return {
        " ".join(value.split())
        for value in re.findall(
            r"\b(?:only\s+if|only\s+when|provided\s+that|as\s+long\s+as|"
            r"no|not|never|without|except|excluding|unless|if|until|after|before|"
            r"don't|doesn't|isn't|can't|won't|shouldn't|wouldn't|"
            r"pretend|imagine|roleplay|kidding|joking|joke|sarcastic|sarcasm)\b",
            text.casefold().replace("’", "'"),
        )
    }


def _conditional_request(text: str) -> bool:
    # Match the condition vocabulary in the language engine's requestConstraints.
    # Quoted product literals such as the perfume "If" are not conditions.
    unquoted = re.sub(r'"[^"\n]*"|“[^”\n]*”', lambda match: " " * len(match[0]), text)
    return bool(
        re.search(
            r"\b(?:only\s+if|only\s+when|provided\s+that|as\s+long\s+as|unless|if)\b",
            unquoted,
            re.IGNORECASE,
        )
    )


def _bare_negated_desire(text: str) -> bool:
    # A standalone denied desire has neither a requested exclusion search nor
    # a scoped yes/no confirmation. Preserve those distinct workflows.
    match = re.fullmatch(
        r"\s*(?:(?:please|pls|plz)\s+)?(?:i|we)\s+"
        r"(?:do\s+not|don't|never)\s+(?:want|need)\s+(.+?)\s*[.!?]*\s*",
        text.replace("’", "'"),
        re.IGNORECASE,
    )
    return bool(
        match
        and not re.search(
            r"[;\n]|\b(?:but|instead|however|then|and|or)\b",
            match[1],
            re.IGNORECASE,
        )
    )


def permits_reinterpretation(message: str, proposal: LanguageProposal) -> bool:
    return not (
        proposal.status != "INTERPRETED"
        or proposal.intent not in PROPOSABLE_INTENTS
        or not proposal.canonical_text
        or _bare_negated_desire(message)
        or _numbers(message) != _numbers(proposal.canonical_text)
        or not _qualifiers(message) <= _qualifiers(proposal.canonical_text)
        or not preserves_literals(message, proposal.canonical_text)
        or (
            proposal.intent in _WRITE_PROPOSAL_INTENTS
            and (
                asks_about_action(message)
                or _conditional_request(message)
                or _conditional_request(proposal.canonical_text)
            )
        )
    )


def accepts_result(
    original: InterpretedRequest,
    result: InterpretedRequest,
    message: str,
    proposal: LanguageProposal,
) -> bool:
    # No retry or recursive fallback: agreement, confidence, and complete single
    # intent semantics are required before existing action handlers can run.
    if result.status == "UNKNOWN" or result.legacy_intent != proposal.intent:
        return False
    if result.request_type or len(result.operations) > 1:
        return False
    if result.status in {"AMBIGUOUS", "NEEDS_CONTEXT"}:
        return False
    if route(result) in {"clarify", "unmapped", "fallback"}:
        return False
    if not preserves_entities(original.entities, result.entities):
        return False
    product = result.entities.get("productText")
    purpose = result.entities.get("catalogPurpose")
    # A purpose-only recommendation searches the catalog generically. "products"
    # is an engine placeholder, not an invented product from a retrieved example.
    # Whole-request matching excludes omitted products, budgets and constraints.
    if (
        product == "products"
        and proposal.intent == "PRODUCT_RECOMMEND"
        and isinstance(purpose, str)
        and re.fullmatch(
            r"(?:(?:please|pls|plz)\s+)?"
            r"(?:(?:i|we)\s+(?:want|need)\s+|(?:need|recommend|suggest)\s+(?:something|products)\s+for\s+|any\s+(?:ideas|suggestions)\s+for\s+)"
            + re.escape(purpose)
            + r"(?:\s+please)?[.!?]*",
            message.strip(),
            re.IGNORECASE,
        )
    ):
        return True
    return not (
        isinstance(product, str) and product.strip() and not _literal(product, message)
    )
