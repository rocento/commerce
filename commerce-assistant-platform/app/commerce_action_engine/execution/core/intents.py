"""Register independent deterministic intent rules; no model selects privileged routes."""

import re
from dataclasses import dataclass

from app.commerce_action_engine.execution.core.meaning import (
    IntentCandidate,
    IntentFrame,
    Span,
)


@dataclass(frozen=True)
class IntentRule:
    name: str
    pattern: str
    route: str | None = None
    required_entities: tuple[str, ...] = ()
    exclusive: bool = False


class IntentRegistry:
    def __init__(self, rules: tuple[IntentRule, ...] = ()):
        self.rules: dict[str, IntentRule] = {}
        for rule in rules:
            self.register(rule)

    def register(self, rule: IntentRule) -> None:
        if rule.name in self.rules:
            raise ValueError("Duplicate intent")
        re.compile(rule.pattern)
        self.rules[rule.name] = rule

    def resolve(self, text: str, entities: frozenset[str] = frozenset()) -> IntentFrame:
        if re.search(r"[\u0600-\u06ff]", text):
            return IntentFrame(
                candidates=()
            )  # Current milestone explicitly defers Arabic.
        candidates, routes = [], []
        for rule in self.rules.values():
            match = (
                re.fullmatch(rule.pattern, text.strip(), re.IGNORECASE)
                if rule.exclusive
                else re.search(rule.pattern, text, re.IGNORECASE)
            )
            if match is None:
                continue
            start = text.find(text.strip()) if rule.exclusive else 0
            missing = tuple(e for e in rule.required_entities if e not in entities)
            candidates.append(
                IntentCandidate(
                    name=rule.name,
                    confidence=1.0 if rule.exclusive else 0.9,
                    evidence=(
                        Span(
                            turn=0, start=start + match.start(), end=start + match.end()
                        ),
                    ),
                    language="en",
                    missing=missing,
                )
            )
            if rule.route and not missing and rule.exclusive:
                routes.append(rule.route)
        return IntentFrame(
            candidates=tuple(candidates),
            route=routes[0] if len(routes) == 1 else None,
            compound=len(candidates) > 1,
        )


def default_registry() -> IntentRegistry:
    return IntentRegistry(
        (
            IntentRule(
                "cart",
                r"(?:please )?(?:(?:show|view|check|what(?:'s| is) in) )?(?:my |the )?(?:cart|basket)(?: status| summary| contents)?[?!.]*",
                "cart",
                exclusive=True,
            ),
            IntentRule(
                "order",
                r"(?:please )?(?:track|show|check|where is) (?:my |the )?order(?: status)?[?!.]*",
                "order",
                exclusive=True,
            ),
            IntentRule(
                "delivery",
                r"(?:do you (?:deliver|ship)(?: here)?|(?:show |check )?delivery (?:status|areas?)|shipping areas?)[?!.]*",
                "delivery",
                exclusive=True,
            ),
            IntentRule("discovery", r"\b(?:find|recommend|search|show)\b"),
            IntentRule("comparison", r"\bcompare\b"),
            IntentRule("alternatives", r"\b(?:alternatives|cheaper)\b"),
            IntentRule("compatibility", r"\b(?:compatible|fits|works with)\b"),
            IntentRule("budget", r"\b(?:under|below|budget|up to|at most)\b"),
            IntentRule("gift", r"\bgifts?\b"),
            IntentRule(
                "planned_basket",
                r"\b(?:plan|build|prepare)\b.*\b(?:basket|cart|meal)\b",
            ),
            IntentRule("replenishment", r"\b(?:buy again|reorder|replenish)\b"),
            IntentRule("support", r"\b(?:support|help|ticket)\b"),
            IntentRule(
                "continuation", r"\b(?:actually|instead|also|change|make that)\b"
            ),
        )
    )
