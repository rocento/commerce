"""Recover bounded discovery context; references are reverified by catalog tools."""

import re
from collections.abc import Callable, Sequence
from typing import Protocol


class HistoryMessage(Protocol):
    @property
    def role(self) -> str: ...

    @property
    def text(self) -> str: ...


FOLLOWUP = re.compile(
    r"^(?:please |pls |plz )?(?:something else|show me something else|recommend something else|other options|show other options|cheaper options|show cheaper options|show me cheaper options|something cheaper)(?: please)?[.!?]*$",
    re.IGNORECASE,
)
ROUTE = re.compile(
    r"/products/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?![\w-])"
)


def discovery_context(
    history: Sequence[HistoryMessage],
    *,
    additional_followup: Callable[[str], bool] | None = None,
) -> tuple[str, list[str], list[str]] | None:
    start = next(
        (
            i
            for i in range(len(history) - 1, -1, -1)
            if history[i].role == "user"
            and not FOLLOWUP.fullmatch(history[i].text.strip())
            and not (additional_followup and additional_followup(history[i].text))
        ),
        None,
    )
    if start is None:
        return None
    seen: list[str] = []
    latest: list[str] = []
    cheaper_references: list[str] = []
    for message in history[start + 1 :]:
        if message.role == "assistant":
            latest = list(
                dict.fromkeys(value.lower() for value in ROUTE.findall(message.text))
            )[:5]
            seen.extend(latest)
        elif message.role == "user" and "cheaper" in message.text.lower():
            cheaper_references = latest
    return history[start].text, list(dict.fromkeys(seen))[:50], cheaper_references


def latest_products(history: Sequence[HistoryMessage]) -> list[str]:
    text = next((m.text for m in reversed(history) if m.role == "assistant"), "")
    return list(dict.fromkeys(value.lower() for value in ROUTE.findall(text)))[:5]
