"""Bounded recent conversation wording; never identity, facts or action authority."""

import re
from collections.abc import Sequence
from typing import Protocol


class HistoryMessage(Protocol):
    @property
    def role(self) -> str: ...

    @property
    def text(self) -> str: ...


_FOLLOWUP = re.compile(
    r"\b(?:it|its|that|those|these|them|same|another|different|cheaper|"
    r"instead|more|less|also|again)\b|"
    r"(?:أرخص|ارخص|غيره|غيرها|نفس|ده|دي|دول|كمان)",
    re.IGNORECASE,
)


def recent_exchange(
    message: str, history: Sequence[HistoryMessage]
) -> tuple[dict[str, str], ...]:
    """Use only the latest exchange for short follow-ups, not independent requests.

    Callers supply history scoped to the admitted shopper/conversation. Skip an
    oversized exchange instead of truncating wording and losing constraints.
    """
    if len(message) > 240 or not _FOLLOWUP.search(message):
        return ()
    rows = history[-4:]
    for index in range(len(rows) - 1, -1, -1):
        if rows[index].role != "user":
            continue
        exchange = rows[index:]
        if (
            len(exchange) > 2
            or not exchange[0].text.strip()
            or any(row.role not in {"user", "assistant"} for row in exchange)
            or any(len(row.text) > 800 for row in exchange)
        ):
            return ()
        return tuple({"role": row.role, "text": row.text} for row in exchange)
    return ()
