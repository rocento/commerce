"""Allowlisted catalog presentations. These structures are never supplied by the model."""

import json
from decimal import Decimal, InvalidOperation, localcontext

from pydantic import BaseModel

from app.commerce_action_engine.actions.catalog import Product
from app.commerce_action_engine.actions.catalog import labels as discovery_labels
from app.commerce_action_engine.contracts import (
    AssistantAction,
    AssistantBlock,
    AssistantCart,
    AssistantCartView,
    AssistantComparisonRow,
    AssistantProduct,
    AssistantProductAttribute,
    AssistantSource,
)


def cart_summary_text(cart: AssistantCart) -> str:
    """Describe verified cart amounts without inventing a checkout quote."""
    quantity = sum(item.quantity for item in cart.items)
    text = (
        f"Your cart has {quantity} item{'s' if quantity != 1 else ''}. "
        if cart.items
        else "Your cart is empty (0 items). "
    )
    try:
        with localcontext() as context:
            context.prec = 80
            subtotal = Decimal(cart.subtotal)
            discount = Decimal(cart.discount_amount)
            if not subtotal.is_finite() or not discount.is_finite():
                raise ValueError("Invalid cart money")
            if subtotal < 0 or discount < 0 or discount > subtotal:
                raise ValueError("Invalid cart discount")
            total = subtotal - discount
    except (InvalidOperation, ValueError):
        return (
            text
            + "I couldn't verify the pricing breakdown. Please open your cart to check it."
        )
    text += (
        f"Subtotal: {subtotal:f} {cart.currency}. "
        f"Total discount: {discount:f} {cart.currency}. "
        f"Cart total after discount: {total:f} {cart.currency} "
        "(before tax and delivery). "
        "Tax, delivery fees, and the final payable total are calculated at checkout."
    )
    if cart.items and not cart.fully_reserved:
        text += (
            " Some items are not currently reserved; review your cart before checkout."
        )
    return text


def cart_block(cart: AssistantCart) -> AssistantBlock:
    """Present the authorized cart snapshot, bounded by the shared stream limit."""
    view = AssistantCartView(
        **cart.model_dump(),
        total_lines=len(cart.items),
        total_quantity=sum(item.quantity for item in cart.items),
    )
    block = AssistantBlock(kind="cart_summary", cart=view)
    # Preserve full names and totals. Very large carts link to their full view.
    while (
        len(json.dumps([block.model_dump(mode="json", exclude_unset=True)]).encode())
        > 24576
    ):
        view.items.pop()
    validate_blocks([block])
    return block


def attributes(product: Product) -> list[AssistantProductAttribute]:
    result = []
    for attr in product.attributes:
        try:
            value = json.loads(attr.value)
        except ValueError:
            value = attr.value
        if isinstance(value, list):
            value = ", ".join(
                str(v) for v in value if isinstance(v, (str, int, float, bool))
            )
        elif not isinstance(value, (str, int, float, bool)):
            continue
        if attr.name.strip() and str(value).strip():
            if attr.source in {"AI_INFERRED", "DERIVED"}:
                value = f"{value} ({attr.source.lower().replace('_', ' ')})"
            result.append(
                AssistantProductAttribute(
                    name=(attr.label or attr.name)[:100], value=str(value)[:250]
                )
            )
    return result


def card(product: Product, reasons: list[str], unmet: list[str]) -> AssistantProduct:
    # Import lazily: importing a shopping submodule initializes the shopping
    # package, whose service module depends on these response helpers.
    from app.commerce_action_engine.actions.shopping.personalization import (
        reasons as personal_reasons,
    )

    return AssistantProduct(
        id=product.id,
        name=product.name,
        image_id=product.image_id,
        price=product.price,
        currency=product.currency,
        in_stock=product.in_stock,
        route=f"/products/{product.id}",
        attributes=attributes(product),
        reasons=list(
            dict.fromkeys(
                discovery_labels(product.discovery)
                + personal_reasons(product)
                + reasons
            )
        )[:20],
        unmet=unmet,
    )


def catalog_block(
    kind: str, products: list[AssistantProduct], title: str
) -> AssistantBlock:
    data: dict[str, object] = {
        "kind": kind,
        "title": title,
        "products": products,
        "sources": [
            AssistantSource(kind="catalog", product_id=p.id, route=p.route)
            for p in products
        ],
    }
    if kind == "comparison_table":
        rows = [
            AssistantComparisonRow(
                label="Current price",
                values=[f"{p.price} {p.currency}" for p in products],
            ),
            AssistantComparisonRow(
                label="Availability",
                values=[availability(p.in_stock) for p in products],
            ),
        ]
        names = sorted({a.name for p in products for a in p.attributes})[:20]
        for name in names:
            rows.append(
                AssistantComparisonRow(
                    label=name,
                    values=[
                        next(
                            (a.value for a in p.attributes if a.name == name),
                            "Not provided",
                        )
                        for p in products
                    ],
                )
            )
        data["rows"] = rows
    return AssistantBlock.model_validate(data)


def availability(value: bool | None) -> str:
    return (
        "In stock"
        if value is True
        else "Out of stock"
        if value is False
        else "Availability unknown"
    )


CAVEAT = "Prices shown are current catalog prices. Tax and delivery may be added at checkout."


def finish(
    blocks: list[AssistantBlock], *, browse_catalog: bool = True
) -> tuple[AssistantBlock, ...]:
    if not blocks:
        blocks.append(
            AssistantBlock(
                kind="text",
                text="I couldn’t find matching products. Try a product type or a different budget.",
            )
        )
    if any(block.products for block in blocks):
        blocks.append(AssistantBlock(kind="text", text=CAVEAT))
    if browse_catalog:
        blocks.append(
            AssistantBlock(
                kind="action",
                action=AssistantAction(label="Browse the catalog", route="/search"),
            )
        )
    validate_blocks(blocks)
    return tuple(blocks)


def validate_blocks(blocks: list[AssistantBlock] | tuple[BaseModel, ...]) -> None:
    """Validate shape relationships as well as the generated closed field schemas."""
    if not 1 <= len(blocks) <= 8:
        raise ValueError("Invalid block count")
    if (
        len(
            json.dumps(
                [b.model_dump(mode="json", exclude_unset=True) for b in blocks]
            ).encode()
        )
        > 24576
    ):
        raise ValueError("Rich response too large")
    for original in blocks:
        b = AssistantBlock.model_validate(original.model_dump(exclude_unset=True))
        fields = set(b.model_fields_set) - {"kind"}
        if b.kind == "cart_removal":
            if fields != {"cart_removal"} or b.cart_removal is None:
                raise ValueError("Invalid cart removal receipt")
            if b.cart_removal.remaining_quantity > b.cart_removal.cart_quantity:
                raise ValueError("Invalid cart removal quantities")
        elif b.kind == "cart_removal_choice":
            if fields != {"cart_removal_choice"} or b.cart_removal_choice is None:
                raise ValueError("Invalid cart removal choice")
            ids = [item.product_id for item in b.cart_removal_choice.items]
            if len(set(ids)) != len(ids):
                raise ValueError("Repeated cart removal choice")
        elif b.kind == "compound_choice":
            if fields != {"compound_choice"} or b.compound_choice is None:
                raise ValueError("Invalid compound choice")
            if {a.destination for a in b.compound_choice.actions} != {
                "cart",
                "wishlist",
            }:
                raise ValueError("Invalid compound destinations")
            if any(
                a.destination == "wishlist" and a.quantity != 1
                for a in b.compound_choice.actions
            ):
                raise ValueError("Invalid wishlist quantity")
        elif b.kind == "product_prompt":
            if fields != {"product_prompt"} or b.product_prompt is None:
                raise ValueError("Invalid product prompt")
        elif b.kind == "text":
            if fields != {"text"}:
                raise ValueError("Invalid text block")
        elif b.kind == "action":
            if fields != {"action"}:
                raise ValueError("Invalid action block")
        elif b.kind == "saved_addresses":
            if fields:
                raise ValueError("Invalid saved addresses block")
        elif b.kind == "wishlist_manage":
            if (
                fields != {"title", "products", "sources"}
                or not b.products
                or not b.sources
            ):
                raise ValueError("Invalid wishlist management block")
        elif b.kind == "basket_proposal":
            if fields != {"proposal_id"} or b.proposal_id is None:
                raise ValueError("Invalid proposal reference")
        elif b.kind == "wishlist_transfer":
            if fields != {"title", "transfer_items"} or not b.transfer_items:
                raise ValueError("Invalid wishlist transfer block")
        elif b.kind == "cart_summary":
            if fields != {"cart"} or b.cart is None:
                raise ValueError("Invalid cart block")
            cart = b.cart
            ids = [item.product_id for item in cart.items]
            quantity = sum(item.quantity for item in cart.items)
            if (
                len(ids) != len(set(ids))
                or cart.total_lines < len(ids)
                or cart.total_quantity < quantity
                or (cart.total_lines > 0 and not ids)
                or (cart.total_lines == len(ids) and cart.total_quantity != quantity)
            ):
                raise ValueError("Invalid cart counts")
        else:
            required = {"title", "products", "sources"}
            if b.kind == "comparison_table":
                required.add("rows")
            if fields != required or not b.products or not b.sources:
                raise ValueError("Invalid catalog block")
            ids = [p.id for p in b.products]
            if len(ids) != len(set(ids)) or [s.product_id for s in b.sources] != ids:
                raise ValueError("Invalid product sources")
            for p, source in zip(b.products, b.sources, strict=True):
                if p.route != f"/products/{p.id}" or source.route != p.route:
                    raise ValueError("Invalid product route")
            if b.kind == "product_card" and len(ids) != 1:
                raise ValueError("Invalid card count")
            if b.kind == "comparison_table" and (
                len(ids) < 2
                or not b.rows
                or any(len(r.values) != len(ids) for r in b.rows)
            ):
                raise ValueError("Invalid comparison dimensions")
