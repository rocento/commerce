"""Deterministic slot filling over standard interpretations and injected ports."""

import re

from app.commerce_action_engine.contracts.interpretation import InterpretationFailure
from app.commerce_action_engine.execution.language.followup_ports import (
    FollowupInterpretation,
    FollowupInterpreter,
)
from app.commerce_action_engine.execution.planning.compound_review import (
    is_reviewed_pair,
)


async def resolve_reply[Result: FollowupInterpretation](
    original: str,
    reply: str,
    interpreter: FollowupInterpreter[Result],
) -> tuple[Result, str]:
    """Revalidate untrusted context and fill a missing slot before resolving again.

    No client-provided intent, product ID, state or question grants authority.
    Clarification replies stay deterministic, including unavailable/unsupported cases.
    """
    previous = await interpreter.resolve(original)
    prior = previous.result
    question = interpreter.question

    def failed(value: Result) -> tuple[Result, str]:
        if (
            isinstance(value.result, InterpretationFailure)
            and value.result.code == "unavailable"
        ):
            return question(
                "I couldn’t reconnect to the language engine. Please retry your reply."
            ), original
        return value, original

    if isinstance(prior, InterpretationFailure):
        return failed(previous)
    if prior.status in {"UNSUPPORTED", "DENIED"}:
        return previous, original
    # Compound replies need application-owned revision validation before this
    # helper. Client text alone cannot resume them through the legacy path.
    if is_reviewed_pair(prior):
        return question(
            "This request needs a current clarification revision. Please send the complete request again."
        ), original
    if (
        previous.route == "clarify"
        and prior.status == "NEEDS_CONTEXT"
        and prior.missing == ["savedCollection"]
    ):
        # Node owns both the ambiguous wording and the allowed collection choices.
        # Replay its freshly revalidated state, never the browser's question.
        if (
            prior.legacy_intent is not None
            or prior.primary_intent is not None
            or prior.entities
            or prior.request_type
            or prior.operations
            or prior.requires_confirmation
            or prior.context_next.get("pendingRequest") != original
            or not 0 < len(reply.strip()) <= 250
        ):
            return previous, original
        resumption = await interpreter.resolve(
            reply.strip(), context={"pendingRequest": original}
        )
        resumed = resumption.result
        if (
            not isinstance(resumed, InterpretationFailure)
            and resumed.status == "RESOLVED"
            and resumed.clarification_reply
            and resumed.interpretation_text
            and not resumed.requires_confirmation
            and not resumed.request_type
            and not resumed.operations
            and not resumed.entities
            and (resumed.legacy_intent, resumption.route)
            in {
                ("VIEW_WISHLIST", "wishlist"),
                ("ACCOUNT_ADDRESS_LIST", "locations"),
            }
        ):
            return resumption, resumed.interpretation_text
        return previous, original
    if (
        previous.route == "product_fact"
        and not prior.entities.get("productText")
        and set(prior.entities) <= {"product_reference"}
    ):
        previous = interpreter.clarify(
            previous,
            "Which product should I check? Please give its full name or SKU.",
            missing=["productReference"],
            reset_confidence=False,
        )
        prior = previous.result
        if isinstance(prior, InterpretationFailure):
            return failed(previous)
    # Replay only engine-issued linguistic state. IDs, permissions and a browser's
    # question text never travel into this state or establish action authority.
    pending = prior.context_next.get("pendingClarification")
    price = prior.entities.get("price")
    if (
        pending is None
        and prior.legacy_intent in {"PRODUCT_SEARCH", "PRODUCT_RECOMMEND"}
        and previous.route == "search"
        and not prior.request_type
        and isinstance(price, dict)
        and not price.get("currency")
        and not prior.entities.get("currency")
        and any(
            isinstance(price.get(key), (int, float)) for key in ("value", "min", "max")
        )
    ):
        # The catalog asks this when it has no authoritative default currency.
        # The engine rechecks the original and accepts a whole currency reply.
        pending = {"text": original, "intent": prior.legacy_intent, "slot": "currency"}
    if (
        isinstance(pending, dict)
        and set(pending) == {"text", "intent", "slot"}
        and pending.get("text") == original
        and pending.get("intent") == prior.legacy_intent
        and pending.get("slot") in ("quantity", "product", "currency")
        and 0 < len(reply.strip()) <= 250
        and "requestConstraints" not in prior.entities
    ):
        resumption = await interpreter.resolve(
            reply.strip(), context={"pendingClarification": pending}
        )
        resumed = resumption.result
        if isinstance(resumed, InterpretationFailure):
            return failed(resumption)
        if (
            resumed.clarification_reply
            and resumed.interpretation_text
            and resumed.legacy_intent == prior.legacy_intent
            and resumption.route not in {"fallback", "unmapped"}
            and (
                prior.request_type != "COMPOUND"
                or (
                    resumed.request_type == "COMPOUND"
                    and set(prior.operations) <= set(resumed.operations)
                )
            )
        ):
            return resumption, resumed.interpretation_text
        return interpreter.clarify(
            previous,
            resumed.message
            or "Please give the requested quantity, product or currency.",
        ), original
    # The application asks for a category when a discovery follow-up has no
    # usable history. Revalidate the original here: the browser's question is
    # not authority, and the engine itself still sees a resolved follow-up.
    if (
        prior.status == "RESOLVED"
        and prior.legacy_intent == "PRODUCT_RECOMMEND"
        and prior.entities.get("recommendationFollowup") in ("cheaper", "different")
        and set(prior.entities) <= {"productText", "recommendationFollowup"}
        and previous.route == "search"
    ):
        answer = reply.strip()
        prompt = "Which product or category? Include a budget if you have one, for example ‘bread under $5’."
        if (
            not answer
            or len(answer) > 250
            or re.search(
                r"[\n;?!]|\b(add|remove|cancel|buy|reorder|checkout|instead|ignore)\b",
                answer,
                re.IGNORECASE,
            )
        ):
            return question(prompt), original
        prefix = (
            "find cheapest "
            if prior.entities["recommendationFollowup"] == "cheaper"
            else "find "
        )
        combined = prefix + answer
        interpretation = await interpreter.resolve(combined)
        result = interpretation.result
        if isinstance(result, InterpretationFailure):
            return failed(interpretation)
        if (
            result.legacy_intent not in {"PRODUCT_SEARCH", "PRODUCT_RECOMMEND"}
            or interpretation.route != "search"
            or result.entities.get("recommendationFollowup")
            or not interpreter.has_plan(interpretation, combined, complete=True)
        ):
            return question(prompt), original
        return interpretation, combined
    if previous.route != "clarify":
        return question(
            "Please start a new message with the complete request."
        ), original
    answer = reply.strip()
    combined = original
    if len(answer) > 250 or not answer:
        return question(
            "Please give a short answer, or start a new message for a different request."
        ), original
    missing = set(prior.missing)
    if (
        missing == {"productReference"}
        and prior.legacy_intent == "CART_MOVE_FROM_WISHLIST"
        and answer.casefold()
        in {"all", "all items", "all of them", "any", "any item", "any one"}
    ):
        selection = "all" if answer.casefold().startswith("all") else "any"
        quantity = prior.entities.get("quantity")
        if quantity is not None or set(prior.entities) - {
            "sourceCollection",
            "destination",
            "productText",
        }:
            return question(
                "Please start a complete request with the items and conditions to move."
            ), original
        combined = f"move {selection} from wishlist to cart"
    elif "productReference" in missing or any(
        field.endswith(".productText") for field in missing
    ):
        # Preserve the original action, quantity, destination and other constraints.
        # Restrict slot filling to a noun phrase; a new action belongs in a new turn.
        if re.search(
            r"[\n;?!]|\b(add|remove|cancel|buy|reorder|checkout|instead|ignore)\b",
            answer,
            re.IGNORECASE,
        ):
            return question(
                "Which product? Use a product name, or start a new message to change the request."
            ), original
        combined, count = re.subn(
            r"\b(?:products?|items?|it|them)\b",
            lambda _: answer,
            original,
            count=1,
            flags=re.IGNORECASE,
        )
        if not count:
            combined = original.rstrip(" ?.") + " " + answer
    elif "delivery.addressReference" in missing and answer.lower() in {
        "home",
        "work",
        "my home address",
        "my work address",
    }:
        address = "my work address" if "work" in answer.lower() else "my home address"
        combined, count = re.subn(
            r"\b(?:there|(?:the |my )?same address|that address)\b",
            lambda match: (
                address
                if re.search(r"\bto\s*$", original[: match.start()])
                else "to " + address
            ),
            original,
            count=1,
            flags=re.IGNORECASE,
        )
        if not count:
            combined = original.rstrip(" ?.") + " to " + address
    elif "orderReference" in missing and re.fullmatch(
        r"(?:order\s*#?\s*)?[1-9][0-9]{0,18}", answer, re.IGNORECASE
    ):
        number = re.sub(r"\D", "", answer)
        # Fill only the reference; delivery, timing and other clauses stay intact.
        combined, count = re.subn(
            r"\b(?:(?:my|the)\s+)?(?:(?:last|same|previous|prior)\s+)?order(?:\s+(?:number|no\.?|#)\s*\d+)?\b",
            "order " + number,
            original,
            count=1,
            flags=re.IGNORECASE,
        )
        if not count:
            return question(
                "Please start a complete request with the order number."
            ), original
    elif "collection" in missing and answer.lower() in {"cart", "wishlist"}:
        combined = original.rstrip(" ?.") + " to " + answer.lower()
    elif "quantity" in missing and re.fullmatch(r"[1-9][0-9]{0,5}", answer):
        combined = original.rstrip(" ?.") + " quantity " + answer
    else:
        return question(
            "Please start a new message with the complete request so I can understand it correctly."
        ), original
    if len(combined) > 4000:
        return question("Please start a shorter complete request."), original
    interpretation = await interpreter.resolve(combined)
    result = interpretation.result
    if isinstance(result, InterpretationFailure):
        return failed(interpretation)
    if prior.request_type == "COMPOUND" and (
        result.request_type != "COMPOUND"
        or not set(prior.operations).issubset(result.operations)
    ):
        return question(
            "Please start a complete request with the order, items, and all conditions."
        ), original
    if interpretation.route == "fallback":
        return question(
            "I still need a clearer answer. Try a specific product name, or start a new message."
        ), original
    if interpretation.route == "search" and not interpreter.has_plan(
        interpretation, combined, complete=False
    ):
        return question(
            "Please start a new message with all product requirements."
        ), original
    return interpretation, combined
