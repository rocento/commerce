"""Request-local use of server-owned memory; observed behavior is only a soft rank signal."""

from __future__ import annotations

import json
import math
import re
from contextvars import ContextVar, Token
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Literal, Protocol
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.commerce_contracts.comparisons import COMPARISON_WORDING
from app.commerce_resolution_engine.contracts import Message

if TYPE_CHECKING:
    from app.commerce_action_engine.actions.catalog import Product

    from .contracts import ShoppingIntent

Recipient = Literal["self", "other"]
Occasion = Literal["everyday", "gift", "work", "travel"]


class DTO(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Snapshot(DTO):
    query: str = Field(max_length=200)
    attributes: dict[str, str] = Field(max_length=10)
    min_price: str | None
    max_price: str | None
    currency: str | None
    brand: str | None
    category: str | None
    exclusive_max: bool = False
    exclusive_min: bool = False
    in_stock: bool = False
    intended_use: str | None = None
    recipient: Literal["self", "other"] | None = None
    occasion: Literal["everyday", "gift", "work", "travel"] | None = None
    excluded_brands: list[str] = Field(default_factory=list, max_length=10)
    shown_brands: list[str] = Field(default_factory=list, max_length=5)
    product_ids: list[UUID] = Field(max_length=5)


class Context(DTO):
    revision: int = Field(ge=0)
    snapshot: Snapshot | None


class Evidence(DTO):
    id: UUID
    attribute: Literal["product", "brand", "color", "style", "metal", "material"]
    value: str = Field(max_length=100)
    category_id: UUID
    occasion: Literal["any", "everyday", "gift", "work", "travel"]
    recipient: Literal["self", "other"]
    goal_id: UUID | None
    signal: Literal["explicit_like", "explicit_dislike"]
    weight: Literal[-100, 100]
    provenance: Literal["customer_control"]
    consent_version: int
    created_at: datetime
    expires_at: datetime


class Signal(DTO):
    product_id: UUID
    category_id: UUID
    name: str = Field(max_length=1000)
    kind: Literal["view", "purchase", "return"]
    weight: int = Field(ge=-60, le=60)
    observed_at: datetime


class Category(DTO):
    id: UUID
    name: str


class ProductOption(Category):
    category_id: UUID


class MemoryView(DTO):
    schema_version: Literal["1.0.0"]
    enabled: bool
    guest: bool
    personalized: bool
    journey_consent: bool
    consent_version: int
    expires_at: datetime | None
    half_life_days: int = Field(ge=1, le=90)
    preferences: list[Evidence] = Field(max_length=100)
    signals: list[Signal] = Field(max_length=20)
    context: Context
    categories: list[Category] = Field(max_length=100)
    products: list[ProductOption] = Field(max_length=5)


class MemoryGateway(Protocol):
    """Scoped optional memory: failed reads return None; failed saves are ignored.

    Transport owns authorization and availability handling; cancellation propagates.
    """

    async def load(self, conversation: UUID) -> MemoryView | None: ...

    async def save(
        self, conversation: UUID, expected_revision: int, snapshot: Snapshot
    ) -> None: ...


_current: ContextVar[Session | None] = ContextVar("personalization", default=None)


@dataclass
class Session:
    view: MemoryView
    memory: MemoryGateway
    conversation: UUID
    message: str
    bypass: bool = False
    snapshot: Snapshot | None = None
    excluded_brands: set[str] = field(default_factory=set)
    recipient: Recipient = "self"
    occasion: Occasion = "everyday"

    def recall(self) -> tuple[Message, ...]:
        snapshot = self.view.context.snapshot
        if not snapshot or not is_followup(self.message):
            return ()
        # This structured state is separate from the visible transcript and durable goals.
        parts = [f"Find {snapshot.query}"]
        parts.extend(f"{key} {value}" for key, value in snapshot.attributes.items())
        if snapshot.brand:
            parts.append(f"brand {snapshot.brand}")
        if snapshot.min_price:
            wording = COMPARISON_WORDING["gt" if snapshot.exclusive_min else "gte"]
            parts.append(f"{wording} {snapshot.min_price} {snapshot.currency or ''}")
        if snapshot.max_price:
            wording = COMPARISON_WORDING["lt" if snapshot.exclusive_max else "lte"]
            parts.append(f"{wording} {snapshot.max_price} {snapshot.currency or ''}")
        if snapshot.in_stock:
            parts.append("in stock")
        if snapshot.intended_use:
            parts.append(f"for {snapshot.intended_use}")
        return (Message("user", "; ".join(parts)),)

    def active(self) -> bool:
        return self.view.enabled and self.view.personalized and not self.bypass

    def reasons_and_score(self, product: Product) -> tuple[list[str], float]:
        if not self.active():
            return [], 0.0
        if product.category_id not in {c.id for c in self.view.categories}:
            return [], 0.0
        now = datetime.now(UTC)
        values = {}
        for attribute in product.attributes:
            if attribute.source in {"AI_INFERRED", "DERIVED"}:
                continue
            try:
                value = json.loads(attribute.value)
            except ValueError:
                continue
            if isinstance(value, str):
                values[attribute.name] = value.casefold()
        values["product"] = str(product.id)
        reasons = []
        explicit = 0.0
        for e in self.view.preferences:
            if (
                e.expires_at <= now
                or e.category_id != product.category_id
                or e.recipient != self.recipient
                or e.occasion not in {"any", self.occasion}
                or (e.goal_id and e.goal_id != self.conversation)
            ):
                continue
            if values.get(e.attribute) != e.value.casefold():
                continue
            # An explicit current dislike always dominates observed history.
            explicit += e.weight
            reasons.append(
                "Matches a preference you saved"
                if e.weight > 0
                else "You saved a dislike for this option"
            )
        inferred = 0.0
        if (
            self.view.journey_consent
            and self.recipient == "self"
            and self.occasion == "everyday"
        ):
            for signal in self.view.signals:
                if (
                    signal.product_id != product.id
                    or signal.category_id != product.category_id
                ):
                    continue
                age = max(0, (now - signal.observed_at).total_seconds() / 86400)
                inferred += signal.weight * math.pow(
                    0.5, age / self.view.half_life_days
                )
                reasons.append(
                    {
                        "view": f"Because you viewed {signal.name}",
                        "purchase": f"Because you purchased {signal.name}",
                        "return": f"You previously returned {signal.name}",
                    }[signal.kind]
                )
        return list(dict.fromkeys(reasons))[:3], max(-100, min(100, explicit)) + max(
            -20, min(20, inferred)
        )


async def begin(
    memory: MemoryGateway | None,
    conversation: UUID | None,
    message: str,
    bypass: bool = False,
) -> Token[Session | None]:
    session = None
    if memory is not None and conversation:
        view = await memory.load(conversation)
        if view is not None and view.enabled:
            session = Session(
                view,
                memory,
                conversation,
                message,
                bypass
                or bool(
                    re.search(
                        r"\b(?:do not|don't) personali[sz]e\b",
                        message,
                        re.IGNORECASE,
                    )
                ),
            )
            session.recipient = (
                "other"
                if re.search(
                    r"\b(?:gift|for my|for her|for him|for them)\b",
                    message,
                    re.IGNORECASE,
                )
                else "self"
            )
            occasions: tuple[Occasion, ...] = ("gift", "work", "travel")
            session.occasion = next(
                (
                    x
                    for x in occasions
                    if re.search(r"\b" + x + r"\b", message, re.IGNORECASE)
                ),
                "everyday",
            )
    if session and is_followup(message) and session.view.context.snapshot:
        previous = session.view.context.snapshot
        session.recipient = previous.recipient or session.recipient
        session.occasion = previous.occasion or session.occasion
    return _current.set(session)


def current() -> Session | None:
    return _current.get()


def reset(token: Token[Session | None]) -> None:
    _current.reset(token)


def rank(product: Product) -> float:
    session = current()
    return session.reasons_and_score(product)[1] if session else 0.0


def reasons(product: Product) -> list[str]:
    session = current()
    return session.reasons_and_score(product)[0] if session else []


def excluded(product: Product) -> bool:
    session = current()
    if not session:
        return False
    for a in product.attributes:
        if a.name == "brand" and a.source not in {"AI_INFERRED", "DERIVED"}:
            try:
                value = json.loads(a.value)
            except ValueError:
                continue
            if isinstance(value, str) and value.casefold() in session.excluded_brands:
                return True
    return False


def is_followup(message: str) -> bool:
    return bool(
        re.search(
            r"^(?:the .+ ones|(?:only|just|same|those|these|not|avoid|exclude|what about|how about)\b)",
            message.strip(),
            re.IGNORECASE,
        )
    )


def restore(plan: ShoppingIntent, message: str) -> None:
    """Preserve hard context independently of extraction on bounded follow-ups."""
    from decimal import Decimal

    from app.commerce_action_engine.actions.shopping.contracts import Constraint

    session = current()
    old = session.view.context.snapshot if session and is_followup(message) else None
    if session is None or old is None:
        return
    plan.shopping = True
    plan.query = old.query
    session.excluded_brands.update(old.excluded_brands)
    current_attributes = {a.name: a.value for a in plan.attributes}
    for name, value in old.attributes.items():
        replacement = current_attributes.get(name)
        if not replacement or replacement.casefold() not in message.casefold():
            current_attributes[name] = value
    removing_brand = bool(
        re.search(r"\b(?:not|avoid|exclude)\b", message, re.IGNORECASE)
    )
    if removing_brand:
        current_attributes.pop("brand", None)
        plan.brand = None
    elif old.brand:
        plan.brand = old.brand
    plan.attributes = [
        Constraint(name=k, value=v) for k, v in current_attributes.items()
    ]
    plan.category = old.category
    plan.in_stock = plan.in_stock or old.in_stock
    plan.intended_use = old.intended_use or plan.intended_use
    if old.max_price and (
        not plan.max_price or Decimal(plan.max_price) >= Decimal(old.max_price)
    ):
        plan.max_price, plan.exclusive_max = old.max_price, old.exclusive_max
    if old.min_price and (
        not plan.min_price or Decimal(plan.min_price) < Decimal(old.min_price)
    ):
        plan.min_price, plan.exclusive_min = old.min_price, old.exclusive_min
    elif (
        old.min_price
        and plan.min_price
        and Decimal(plan.min_price) == Decimal(old.min_price)
    ):
        plan.exclusive_min = plan.exclusive_min or old.exclusive_min
    plan.currency = old.currency or plan.currency
    plan.alternatives = False


def prepare(message: str, products: list[Product]) -> str | None:
    session = current()
    if not session:
        return None
    brands = set()
    for product in products:
        for a in product.attributes:
            if a.name == "brand" and a.source not in {"AI_INFERRED", "DERIVED"}:
                try:
                    value = json.loads(a.value)
                except ValueError:
                    continue
                if isinstance(value, str):
                    brands.add(value.casefold())
    if re.search(r"\bnot (?:this|that) brand\b", message, re.IGNORECASE):
        previous = session.view.context.snapshot
        known = set(previous.shown_brands) if previous else set()
        if len(known) != 1:
            return "Which brand should I exclude? Please name it so I can keep your other requirements."
        session.excluded_brands.update(known)
    for brand in brands:
        if re.search(
            r"\b(?:not|no|avoid|exclude)\s+" + re.escape(brand) + r"\b",
            message,
            re.IGNORECASE,
        ):
            session.excluded_brands.add(brand)

    return None


def remember(plan: ShoppingIntent, products: list[Product]) -> None:
    session = current()
    if session and products:
        session.snapshot = Snapshot(
            query=plan.query,
            attributes={a.name: a.value for a in plan.attributes},
            min_price=plan.min_price,
            max_price=plan.max_price,
            currency=plan.currency,
            brand=plan.brand,
            category=plan.category,
            exclusive_max=plan.exclusive_max,
            exclusive_min=plan.exclusive_min,
            in_stock=plan.in_stock,
            intended_use=plan.intended_use,
            recipient=session.recipient,
            occasion=session.occasion,
            excluded_brands=sorted(session.excluded_brands)[:10],
            shown_brands=sorted(
                {
                    value.casefold()
                    for p in products[:5]
                    for a in p.attributes
                    if a.name == "brand" and a.source not in {"AI_INFERRED", "DERIVED"}
                    for value in [_string_value(a.value)]
                    if isinstance(value, str)
                }
            )[:5],
            product_ids=[p.id for p in products[:5]],
        )


async def flush() -> None:
    session = current()
    if session is None or session.snapshot is None:
        return
    await session.memory.save(
        session.conversation, session.view.context.revision, session.snapshot
    )


def _string_value(value: str) -> str | None:
    try:
        result = json.loads(value)
        return result if isinstance(result, str) else None
    except ValueError:
        return None
