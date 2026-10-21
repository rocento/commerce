"""Immutable inventory of existing commerce actions; this module does not execute them."""

from collections.abc import Iterable
from functools import lru_cache
from types import MappingProxyType

from app.commerce_action_engine.actions.catalog import DEFINITIONS
from app.commerce_action_engine.contracts.action import Confirmation
from app.commerce_action_engine.contracts.commerce_action import (
    ActionClassification,
    ActionDomain,
    CommerceActionDefinition,
)


class ActionRegistryError(ValueError):
    """Bounded registry configuration failure."""


class ActionRegistry:
    def __init__(self, definitions: Iterable[CommerceActionDefinition]):
        records: dict[str, CommerceActionDefinition] = {}
        for definition in definitions:
            if definition.name in records:
                raise ActionRegistryError("duplicate_action")
            records[definition.name] = definition
        self._records = MappingProxyType(records)

    def get(self, name: str) -> CommerceActionDefinition:
        try:
            return self._records[name]
        except KeyError:
            raise ActionRegistryError("unknown_action") from None

    def all(self) -> tuple[CommerceActionDefinition, ...]:
        return tuple(self._records.values())

    def for_domain(self, domain: str) -> tuple[CommerceActionDefinition, ...]:
        return tuple(item for item in self._records.values() if item.domain == domain)


def _read(
    name: str,
    domain: ActionDomain,
    input_contract: str,
    output_contract: str,
    implementation: str,
    *,
    intents: tuple[str, ...] = (),
    requires_capability: bool = True,
) -> CommerceActionDefinition:
    return CommerceActionDefinition(
        name=name,
        domain=domain,
        classification=ActionClassification.READ,
        input_contract=input_contract,
        output_contract=output_contract,
        implementation=implementation,
        intents=intents,
        requires_capability=requires_capability,
    )


def _write(
    name: str,
    domain: ActionDomain,
    input_contract: str,
    output_contract: str,
    implementation: str,
    *,
    intents: tuple[str, ...],
) -> CommerceActionDefinition:
    return CommerceActionDefinition(
        name=name,
        domain=domain,
        classification=ActionClassification.WRITE,
        input_contract=input_contract,
        output_contract=output_contract,
        implementation=implementation,
        intents=intents,
        confirmation=Confirmation.INTENT,
        replay="never",
    )


def definitions() -> tuple[CommerceActionDefinition, ...]:
    catalog = tuple(
        _read(
            f"catalog.{definition.name}",
            "catalog",
            f"catalog://{definition.name}-v1",
            "catalog://result-v1",
            "app.commerce_action_engine.application.catalog:registry",
        )
        for definition in DEFINITIONS
    )
    return catalog + (
        _read(
            "shopping.answer",
            "shopping",
            "shopping://intent-v1",
            "assistant://shopping-answer-v1",
            "app.commerce_action_engine.application.shopping:shopping_answer",
        ),
        _read(
            "basket.propose",
            "basket",
            "shopping://basket-goal-v1",
            "shopping://basket-proposal-v1",
            "app.commerce_action_engine.application.baskets:plan_basket",
        ),
        _read(
            "cart.read",
            "cart",
            "commerce://empty-v1",
            "commerce://cart-v1",
            "app.commerce_action_engine.adapters.commerce:CommerceTools.cart",
            intents=("VIEW_CART", "CART_TOTAL", "CART_ITEM_COUNT"),
        ),
        _write(
            "cart.add",
            "cart",
            "commerce://cart-command-v1",
            "commerce://cart-v1",
            "app.commerce_action_engine.actions.shopping.cart:execute",
            intents=("ADD_TO_CART",),
        ),
        _write(
            "cart.remove",
            "cart",
            "commerce://cart-command-v1",
            "commerce://cart-v1",
            "app.commerce_action_engine.actions.shopping.cart:execute",
            intents=("REMOVE_FROM_CART",),
        ),
        _write(
            "cart.clear",
            "cart",
            "commerce://cart-command-v1",
            "commerce://cart-v1",
            "app.commerce_action_engine.actions.shopping.cart:execute",
            intents=("CLEAR_CART",),
        ),
        _write(
            "cart.set_quantity",
            "cart",
            "commerce://cart-command-v1",
            "commerce://cart-v1",
            "app.commerce_action_engine.actions.shopping.cart:execute",
            intents=("UPDATE_CART_QUANTITY",),
        ),
        _read(
            "cart.checkout_link",
            "cart",
            "commerce://cart-command-v1",
            "commerce://cart-v1",
            "app.commerce_action_engine.actions.shopping.cart:execute",
            intents=("START_CHECKOUT", "CONTINUE_CHECKOUT", "CREATE_ORDER"),
        ),
        _write(
            "cart.save_to_wishlist",
            "cart",
            "commerce://cart-command-v1",
            "commerce://cart-v1",
            "app.commerce_action_engine.actions.shopping.cart:execute",
            intents=("ADD_TO_WISHLIST",),
        ),
        _write(
            "cart.move_to_wishlist",
            "cart",
            "commerce://cart-command-v1",
            "commerce://cart-v1",
            "app.commerce_action_engine.actions.shopping.cart:execute",
            intents=("CART_MOVE_TO_WISHLIST",),
        ),
        _read(
            "customer.delivery",
            "customer",
            "commerce://empty-v1",
            "commerce://delivery-v1",
            "app.commerce_action_engine.adapters.commerce:CommerceTools.delivery",
            intents=("DELIVERY_STATUS",),
        ),
        _read(
            "customer.locations",
            "customer",
            "commerce://empty-v1",
            "commerce://locations-v1",
            "app.commerce_action_engine.adapters.commerce:CommerceTools.locations",
            intents=(
                "ACCOUNT_ADDRESS_LIST",
                "ACCOUNT_ADDRESS_ADD",
                "ACCOUNT_ADDRESS_REMOVE",
                "ACCOUNT_ADDRESS_DEFAULT",
            ),
        ),
        _read(
            "customer.wishlist",
            "customer",
            "commerce://empty-v1",
            "commerce://wishlist-v1",
            "app.commerce_action_engine.adapters.commerce:CommerceTools.wishlist",
            intents=("VIEW_WISHLIST", "REMOVE_FROM_WISHLIST"),
        ),
        _read(
            "order.list",
            "order",
            "commerce://empty-v1",
            "commerce://orders-v1",
            "app.commerce_action_engine.adapters.commerce:CommerceTools.orders",
            intents=(
                "TRACK_ORDER",
                "ORDER_HISTORY",
                "ORDER_STATUS",
                "ORDER_VIEW",
                "VIEW_ORDER",
                "ORDER_DETAILS",
                "ORDER_CANCEL_ELIGIBILITY",
                "ORDER_CANCEL_STATUS",
                "ORDER_DAMAGED",
                "ORDER_WRONG_ITEM",
            ),
        ),
        _read(
            "order.by_number",
            "order",
            "commerce://order-number-v1",
            "commerce://order-v1",
            "app.commerce_action_engine.adapters.commerce:CommerceTools.order_by_number",
            intents=(
                "TRACK_ORDER",
                "ORDER_STATUS",
                "ORDER_VIEW",
                "VIEW_ORDER",
                "ORDER_DETAILS",
                "ORDER_CANCEL_ELIGIBILITY",
                "ORDER_CANCEL_STATUS",
            ),
        ),
        _read(
            "order.shipment_status",
            "order",
            "commerce://order-args-v1",
            "commerce://order-v1",
            "app.commerce_action_engine.adapters.commerce:CommerceTools.call",
            intents=("SHIPMENT_TRACKING", "ORDER_SHIPMENT_STATUS"),
        ),
        _write(
            "order.reorder",
            "order",
            "commerce://reorder-command-v1",
            "commerce://order-v1",
            "app.commerce_action_engine.adapters.reorder:execute",
            intents=("REORDER",),
        ),
        _read(
            "support.list_tickets",
            "support",
            "commerce://empty-v1",
            "commerce://tickets-v1",
            "app.commerce_action_engine.adapters.commerce:CommerceTools.support_tickets",
            intents=(
                "SUPPORT_TICKET_STATUS",
                "SUPPORT_TICKET_CLOSE",
                "SUPPORT_TICKET_REOPEN",
                "SUPPORT_ESCALATE",
                "SUPPORT_CALLBACK",
            ),
        ),
        _read(
            "support.get_ticket",
            "support",
            "commerce://ticket-id-v1",
            "commerce://ticket-v1",
            "app.commerce_action_engine.adapters.commerce:CommerceTools.support_ticket",
            intents=("SUPPORT_CHAT_HISTORY",),
        ),
        _write(
            "support.create_ticket",
            "support",
            "commerce://ticket-input-v1",
            "commerce://ticket-v1",
            "app.commerce_action_engine.adapters.commerce:CommerceTools.create_ticket",
            intents=(),
        ),
        _read(
            "policy.answer",
            "policy",
            "assistant://message-v1",
            "assistant://text-v1",
            "app.commerce_action_engine.actions.policy:PolicyAnswers.match",
            requires_capability=False,
        ),
    )


@lru_cache(maxsize=1)
def default_registry() -> ActionRegistry:
    return ActionRegistry(definitions())


__all__ = [
    "ActionRegistry",
    "ActionRegistryError",
    "default_registry",
    "definitions",
]
