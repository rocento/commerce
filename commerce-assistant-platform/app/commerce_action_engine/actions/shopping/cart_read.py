"""Read the caller's authoritative cart without presentation or mutation policy."""

from dataclasses import dataclass
from typing import Protocol

from app.commerce_action_engine.contracts import AssistantCart


class CartReader(Protocol):
    """Read the current cart using the caller's scoped capability."""

    async def cart(self) -> AssistantCart: ...


@dataclass(frozen=True)
class CartReadResult:
    """An authoritative snapshot; formatting belongs to the application handler."""

    cart: AssistantCart


async def read_cart(reader: CartReader) -> CartReadResult:
    """Read once; let the admitted turn handle failures and cancellation."""
    return CartReadResult(cart=await reader.cart())
