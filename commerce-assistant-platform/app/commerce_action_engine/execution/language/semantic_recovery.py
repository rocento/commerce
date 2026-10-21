"""Bounded read candidates from reviewed prefixes, never neighbor slot values."""

import re
import unicodedata

from app.commerce_action_engine.execution.language.proposals import (
    permits_reinterpretation,
)
from app.commerce_contracts.intent_example import IntentEvidence
from app.commerce_contracts.language_proposal import LanguageProposal

READ_RECOVERY_INTENTS = frozenset({"PRODUCT_SEARCH", "PRODUCT_RECOMMEND"})
# A candidate must describe one affirmative read. Complex requests retain the
# existing UNKNOWN fallback/clarification path instead of partial execution.
UNSAFE = re.compile(
    r"\b(?:and|or|then|if|unless|after|before|not|no|never|without|except|add|remove|delete|clear|cancel|buy|order|checkout|pay|ship|deliver|pretend|joke|joking)\b|[\";\n]|don['’]t",
    re.IGNORECASE,
)


def read_candidates(
    message: str, evidence: tuple[IntentEvidence, ...]
) -> tuple[LanguageProposal, ...]:
    if (
        not message.strip()
        or len(message) > 4000
        or len(evidence) > 3
        or UNSAFE.search(message)
        or any(c.isalpha() and "LATIN" not in unicodedata.name(c, "") for c in message)
    ):
        return ()
    candidates: dict[tuple[str, str], LanguageProposal] = {}
    for item in evidence:
        example = item.example
        review = example.review
        if (
            example.intent not in READ_RECOVERY_INTENTS
            or review is None
            or review.label != "positive"
            or review.review_status != "approved"
            or review.split != "train"
            or review.context_requirements
            or review.recovery is None
            or item.validation_fingerprint is None
        ):
            continue
        canonical = review.recovery.render(message)
        if canonical is None:
            continue
        proposal = LanguageProposal(
            status="INTERPRETED", intent=example.intent, canonical_text=canonical
        )
        if permits_reinterpretation(message, proposal):
            candidates[(example.intent, canonical)] = proposal
    return tuple(candidates.values())
