"""Explicit catalog evidence and bounded requests for missing requirement evidence."""

import json
import re
from dataclasses import dataclass
from typing import Literal

from app.commerce_action_engine.actions.catalog import Product

QUESTIONS = {
    "medical_treatment": "I cannot recommend grocery products as a guaranteed cure or treatment. I can help compare documented ingredients and nutrition; treatment decisions need a qualified healthcare professional.",
    "allergy_safety": "I cannot verify allergy safety from a product name or missing allergen tags. Which exact product should I check for an explicit allergen and cross-contact statement?",
    "pregnancy_suitability": "The catalog cannot establish personal suitability during pregnancy. Which exact product and ingredients do you want to review with your clinician or pharmacist?",
    "device_compatibility": "What is your device's exact manufacturer and model, and any required connector or version? I need an explicit compatibility specification before claiming a match.",
    "named_device_compatibility": "Which manufacturer's compatibility specification should I use for the model you named, and what connector or version is required? I cannot confirm compatibility from a model name alone.",
    "manufacturing_method": "What manufacturing processes do you want to exclude, and would a maker's documented production method satisfy your requirement? A product name or handmade label alone does not establish where or how it was made.",
    "ingredient_exclusion": "A vegan tag alone does not verify that no animal-derived ingredients are hidden. Which exact product should I check for a complete ingredient list and an explicit manufacturer declaration?",
    "delivery_deadline": "What delivery address and exact date, time, and time zone do you need? Only current checkout delivery-slot evidence can confirm that deadline; catalog stock cannot.",
    "household_value": "What quantity or serving size and time period does your family need, and what total budget should I compare? I need comparable pack sizes and unit prices to assess value.",
}


def requirement_clarification(rows: object, message: str) -> str | None:
    """Validate untrusted language spans before choosing fixed domain guidance."""
    if not isinstance(rows, list) or not 1 <= len(rows) <= 10:
        return None
    kinds = []
    for row in rows:
        if not isinstance(row, dict):
            return None
        kind, start, end = row.get("kind"), row.get("start"), row.get("end")
        if (
            not isinstance(kind, str)
            or kind not in QUESTIONS
            or type(start) is not int
            or type(end) is not int
            or not 0 <= start < end <= len(message)
            or message[start:end] != row.get("text")
        ):
            return None
        if kind not in kinds:
            kinds.append(kind)
    answers = []
    for kind in kinds:
        if kind in {"named_device_compatibility", "device_compatibility"} and re.search(
            r"\b(?:chargers?|cables?|power adapter|wall adapter)\b",
            message,
            re.IGNORECASE,
        ):
            source = next(row["text"] for row in rows if row["kind"] == kind)
            model = re.sub(
                r"^(?:for|compatible with)\s+(?:(?:an?|my|the)\s+)?",
                "",
                source,
                flags=re.IGNORECASE,
            )
            model = re.sub(r"[\[\]()*_`<>\\\x00-\x1f]", " ", model).strip()[:100]
            if kind == "device_compatibility":
                answers.append(
                    f"Which exact {model} model should this accessory work with? "
                    "Share the cable connector or a candidate product link so I can check the catalog's listed connector, power rating, and explicit device compatibility. "
                    "The device family name alone does not confirm a match."
                )
                continue
            answers.append(
                f"For {model}, what should the cable connect to? "
                "Share the other device's connector or a candidate product link so I can check the catalog's listed connectors, power rating, and explicit device compatibility. "
                "I cannot confirm a match from the device name alone."
                if re.search(r"\bcables?\b", message, re.IGNORECASE)
                and not re.search(r"\bchargers?\b", message, re.IGNORECASE)
                else f"For {model}, do you need a wall adapter, a charging cable, or both? "
                "Share the cable connector or a candidate product link so I can check the catalog's listed connector, power rating, and explicit device compatibility. "
                "I cannot confirm a match from the device name alone."
            )
        else:
            answers.append(QUESTIONS[kind])
    return " ".join(answers)


@dataclass(frozen=True)
class AttributeEvidence:
    status: Literal["verified", "contradicted", "unknown"]
    sources: tuple[str, ...] = ()


def attribute_evidence(
    product: Product, name: str, value: str, *, allow_inferred: bool = False
) -> AttributeEvidence:
    def norm(raw: str) -> str:
        return " ".join(raw.casefold().replace("_", " ").split())

    rows = [a for a in product.attributes if norm(a.name) == norm(name)]
    if not rows:
        return AttributeEvidence("unknown")
    facts = []
    sources = []
    for row in rows:
        if row.source in {"AI_INFERRED", "DERIVED"} and not allow_inferred:
            continue
        try:
            raw = json.loads(row.value)
        except ValueError:
            raw = row.value
        if isinstance(raw, list) and any(isinstance(v, bool) for v in raw):
            return AttributeEvidence("unknown")
        items = raw if isinstance(raw, list) else [raw]
        if not items or any(not isinstance(v, (str, int, float, bool)) for v in items):
            return AttributeEvidence("unknown")
        facts.append(frozenset(norm(str(v)) for v in items))
        sources.append(row.source)
    if not facts or len(set(facts)) != 1:
        # Conflicting authoritative rows cannot be resolved by attribute order.
        return AttributeEvidence("unknown", tuple(sorted(set(sources))))
    return AttributeEvidence(
        "verified" if norm(value) in facts[0] else "contradicted",
        tuple(sorted(set(sources))),
    )
