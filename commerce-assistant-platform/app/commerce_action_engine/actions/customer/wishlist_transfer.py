"""Admit and execute wishlist transfers through customer-scoped commerce ports.

Selection preparation performs reads only. Named transfers remove a saved item
only after cart confirmation; uncertain mutations are never retried here.
"""

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Literal
from uuid import UUID

from app.commerce_action_engine.actions.customer.transfers import (
    WishlistJourneyPort,
    WishlistTransferPort,
    WishlistTransferReceipt,
)
from app.commerce_action_engine.contracts import AssistantCart
from app.commerce_action_engine.contracts.interpretation import InterpretedRequest
from app.commerce_action_engine.shared.errors import ToolDenied, ToolUnavailable

type Selection = Literal["ALL_SAVED", "RANDOM_SAVED"]


@dataclass(frozen=True)
class TransferNeedsInput:
    reason: Literal[
        "login_required",
        "incomplete_request",
        "unsupported_selection",
        "missing_product",
        "invalid_quantity",
    ]
    message: str = ""


@dataclass(frozen=True)
class NamedTransferRequest:
    name: str
    # Preserve validation after the owned-product lookup, as in the existing flow.
    quantity: object


@dataclass(frozen=True)
class SelectionTransferRequest:
    selection: Selection


@dataclass(frozen=True)
class SelectionStopped:
    reason: Literal["read_unavailable", "empty", "limit"]


@dataclass(frozen=True)
class PreparedSelection:
    selection: Selection
    product_ids: tuple[UUID, ...]


@dataclass(frozen=True)
class SelectionUnverified:
    product_ids: tuple[UUID, ...]


@dataclass(frozen=True)
class SelectionCompleted:
    receipt: WishlistTransferReceipt


@dataclass(frozen=True)
class TransferLookupFailed:
    name: str


@dataclass(frozen=True)
class TransferNotMatched:
    name: str
    reason: Literal["not_found", "ambiguous"]


@dataclass(frozen=True)
class TransferCartUnverified:
    name: str
    reason: Literal["write_unavailable", "absent_from_cart"]


@dataclass(frozen=True)
class TransferRemovalUnverified:
    """Cart addition is confirmed; wishlist removal is not."""

    name: str
    quantity: int
    cart: AssistantCart


@dataclass(frozen=True)
class TransferCompleted:
    """Cart confirmation and wishlist removal acknowledgement both exist."""

    name: str
    quantity: int
    cart: AssistantCart


type TransferAdmission = (
    TransferNeedsInput | NamedTransferRequest | SelectionTransferRequest
)
type SelectionPreparation = SelectionStopped | PreparedSelection
type SelectionResult = SelectionUnverified | SelectionCompleted
type NamedTransferResult = (
    TransferNeedsInput
    | TransferLookupFailed
    | TransferNotMatched
    | TransferCartUnverified
    | TransferRemovalUnverified
    | TransferCompleted
)


def _query(result: InterpretedRequest) -> str:
    for key in ("productText", "category"):
        value = result.entities.get(key)
        if isinstance(value, str) and value.strip():
            value = value.strip()
            for prefix in ("wishlist item ", "wish list item ", "item ", "product "):
                if value.casefold().startswith(prefix):
                    value = value[len(prefix) :].strip()
            if value:
                return value
    return ""


def admit_transfer(
    request: InterpretedRequest, *, authenticated: bool
) -> TransferAdmission:
    if not authenticated:
        return TransferNeedsInput("login_required")
    if (
        request.status != "RESOLVED"
        or request.confidence.raw < 0.65
        or request.missing
        or request.request_type
    ):
        return TransferNeedsInput("incomplete_request", request.message)
    selection = request.entities.get("selection")
    if isinstance(selection, str) and selection in {"ALL_SAVED", "RANDOM_SAVED"}:
        if (
            request.legacy_intent != "CART_MOVE_FROM_WISHLIST"
            or request.entities.get("sourceCollection") != "wishlist"
            or request.entities.get("destination") != "cart"
            or set(request.entities)
            - {"sourceCollection", "destination", "selection", "productText"}
            or request.entities.get("productText", "")
            not in {
                "",
                "all",
                "all items",
                "all products",
                "all of them",
                "any",
                "any item",
                "any product",
                "any one",
            }
        ):
            return TransferNeedsInput("unsupported_selection")
        return SelectionTransferRequest(
            "ALL_SAVED" if selection == "ALL_SAVED" else "RANDOM_SAVED"
        )
    name = _query(request)
    if not name:
        return TransferNeedsInput("missing_product")
    return NamedTransferRequest(name, request.entities.get("quantity", 1))


async def prepare_selection(
    request: SelectionTransferRequest,
    tools: WishlistTransferPort,
    *,
    choose: Callable[[Sequence[UUID]], UUID],
) -> SelectionPreparation:
    try:
        saved = list(dict.fromkeys(await tools.wishlist()))
    except ToolUnavailable:
        return SelectionStopped("read_unavailable")
    if not saved:
        return SelectionStopped("empty")
    selected = [choose(saved)] if request.selection == "RANDOM_SAVED" else saved
    if len(selected) > 200:
        return SelectionStopped("limit")
    return PreparedSelection(request.selection, tuple(selected))


async def execute_selection(
    prepared: PreparedSelection, tools: WishlistTransferPort
) -> SelectionResult:
    try:
        receipt = await tools.transfer_wishlist_to_cart(list(prepared.product_ids))
    except ToolUnavailable:
        return SelectionUnverified(prepared.product_ids)
    return SelectionCompleted(receipt)


async def transfer_named(
    request: NamedTransferRequest,
    tools: WishlistJourneyPort,
    *,
    record_completed_call: Callable[[int], None],
) -> NamedTransferResult:
    """Report successful calls before the next await, including before denial.

    The observer preserves turn accounting without giving the domain response
    metadata or stream ownership. Cancellation and denial propagate unchanged.
    """
    name = request.name
    try:
        wishlist_ids = await tools.wishlist()
        record_completed_call(1)
        products = await tools.search_cart_product(name)
        record_completed_call(2)
    except ToolUnavailable:
        return TransferLookupFailed(name)

    def normalized(value: str) -> str:
        return " ".join(value.casefold().split())

    matches = [
        p
        for p in products
        if UUID(str(p["id"])) in wishlist_ids
        and normalized(str(p["name"])) == normalized(name)
    ]
    if len(matches) != 1:
        return TransferNotMatched(name, "ambiguous" if matches else "not_found")
    product = matches[0]
    product_id = UUID(str(product["id"]))
    quantity = request.quantity
    if (
        isinstance(quantity, bool)
        or not isinstance(quantity, int)
        or not 1 <= quantity <= 1000
    ):
        return TransferNeedsInput("invalid_quantity")
    name = str(product["name"])
    try:
        cart = await tools.change_cart(
            {"action": "add", "product_id": str(product_id), "quantity": quantity}
        )
        record_completed_call(3)
    except ToolUnavailable:
        return TransferCartUnverified(name, "write_unavailable")
    if not any(item.product_id == product_id for item in cart.items):
        return TransferCartUnverified(name, "absent_from_cart")
    try:
        await tools.remove_wishlist_item(product_id)
        record_completed_call(4)
    except ToolDenied as error:
        error.completed_action = "cart_add"
        raise
    except ToolUnavailable:
        return TransferRemovalUnverified(name, quantity, cart)
    return TransferCompleted(name, quantity, cart)
