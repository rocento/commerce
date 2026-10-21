"""Resolve owned wishlist items and report acknowledged or verified removals.

Callers supply IDs from the scoped wishlist read. Bulk clearing is bounded and
serial; a denial, cancellation or uncertain write stops all successor work.
"""

from collections.abc import Callable, Sequence
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
from typing import Any, Protocol
from uuid import UUID

from app.commerce_action_engine.actions.catalog.references import exact_products
from app.commerce_action_engine.shared.errors import ToolUnavailable

MAX_CLEAR_ITEMS = 100


class WishlistRemover(Protocol):
    async def remove_wishlist_item(self, product_id: UUID) -> None: ...


class WishlistClearPort(WishlistRemover, Protocol):
    async def wishlist(self) -> list[UUID]: ...


@dataclass(frozen=True)
class WishlistEmpty:
    """No saved IDs were supplied; no operation is required."""


@dataclass(frozen=True)
class WishlistClearLimit:
    count: int
    limit: int


@dataclass(frozen=True)
class WishlistClearCompleted:
    requested_ids: tuple[UUID, ...]
    remaining_ids: tuple[UUID, ...]
    attempted_calls: int


@dataclass(frozen=True)
class WishlistClearRemaining:
    """The final read still contains one or more of the requested IDs."""

    requested_ids: tuple[UUID, ...]
    remaining_ids: tuple[UUID, ...]
    attempted_calls: int


@dataclass(frozen=True)
class WishlistClearRemovalUnverified:
    requested_ids: tuple[UUID, ...]
    acknowledged_ids: tuple[UUID, ...]
    uncertain_id: UUID
    attempted_calls: int


@dataclass(frozen=True)
class WishlistClearVerificationUnavailable:
    """All removals were acknowledged, but the final state could not be read."""

    acknowledged_ids: tuple[UUID, ...]
    attempted_calls: int


@dataclass(frozen=True)
class WishlistRemovalReady:
    product_id: UUID
    name: str


@dataclass(frozen=True)
class WishlistRemovalChoice:
    items: tuple[dict[str, Any], ...]


@dataclass(frozen=True)
class WishlistRemovalNotFound:
    """The catalog returned no customer-owned matches."""


@dataclass(frozen=True)
class WishlistRemoved:
    """The scoped deletion endpoint acknowledged this one product's removal."""

    product_id: UUID
    name: str


@dataclass(frozen=True)
class WishlistRemovalUnverified:
    product_id: UUID
    name: str


type WishlistClearResult = (
    WishlistEmpty
    | WishlistClearLimit
    | WishlistClearCompleted
    | WishlistClearRemaining
    | WishlistClearRemovalUnverified
    | WishlistClearVerificationUnavailable
)
type WishlistRemovalSelection = (
    WishlistRemovalReady | WishlistRemovalChoice | WishlistRemovalNotFound
)
type WishlistRemovalResult = WishlistRemoved | WishlistRemovalUnverified


def match_removal(
    product_ids: Sequence[UUID], found: Sequence[dict[str, Any]], reference: str
) -> WishlistRemovalSelection:
    saved = {str(product_id) for product_id in product_ids}
    items = [product for product in found if str(product["id"]) in saved]
    exact = exact_products(items, reference)
    if len(exact) == 1:
        return WishlistRemovalReady(UUID(str(exact[0]["id"])), str(exact[0]["name"]))
    if not items:
        return WishlistRemovalNotFound()
    return WishlistRemovalChoice(tuple(items))


async def remove_selected(
    selected: WishlistRemovalReady,
    tools: WishlistRemover,
    *,
    measure_write: Callable[[], AbstractContextManager[None]] = nullcontext,
) -> WishlistRemovalResult:
    try:
        # Let the application observe the original failure before converting it
        # to an outcome. The domain has no dependency on concrete telemetry.
        with measure_write():
            await tools.remove_wishlist_item(selected.product_id)
    except ToolUnavailable:
        return WishlistRemovalUnverified(selected.product_id, selected.name)
    return WishlistRemoved(selected.product_id, selected.name)


async def clear_wishlist(
    product_ids: Sequence[UUID], tools: WishlistClearPort
) -> WishlistClearResult:
    requested = tuple(dict.fromkeys(product_ids))
    if not requested:
        return WishlistEmpty()
    if len(requested) > MAX_CLEAR_ITEMS:
        return WishlistClearLimit(len(requested), MAX_CLEAR_ITEMS)
    # Preserve existing turn accounting, including its initial wishlist read.
    attempted = 1
    acknowledged: list[UUID] = []
    for product_id in requested:
        attempted += 1
        try:
            await tools.remove_wishlist_item(product_id)
        except ToolUnavailable:
            return WishlistClearRemovalUnverified(
                requested, tuple(acknowledged), product_id, attempted
            )
        acknowledged.append(product_id)
    attempted += 1
    try:
        remaining = tuple(await tools.wishlist())
    except ToolUnavailable:
        return WishlistClearVerificationUnavailable(tuple(acknowledged), attempted)
    if set(requested).intersection(remaining):
        return WishlistClearRemaining(requested, remaining, attempted)
    return WishlistClearCompleted(requested, remaining, attempted)
