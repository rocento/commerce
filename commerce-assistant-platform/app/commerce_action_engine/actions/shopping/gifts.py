"""Gift context guides discovery without claiming age or occasion suitability."""

from app.commerce_action_engine.actions.catalog import CatalogSchema

from .constraints import normalized
from .contracts import Constraint, ShoppingIntent


def gift_preferences(plan: ShoppingIntent, schema: CatalogSchema) -> None:
    if not plan.gift_context:
        return
    # Only explicit merchant occasion/use options influence ranking. Recipient
    # relationships never imply gender, age, health needs, or product attributes.
    wanted = {"gift"}
    if plan.gift_context.occasion:
        wanted.add(normalized(plan.gift_context.occasion))
    for definition in schema.attributes:
        if definition.semantic_role != "intended_use" or not definition.filterable:
            continue
        if any(
            c.name == definition.code for c in [*plan.attributes, *plan.preferences]
        ):
            continue
        matches = [
            o
            for o in definition.options
            if wanted.intersection(
                normalized(n) for n in (o.code, o.label, *o.labels.values())
            )
        ]
        if len(matches) == 1 and len(plan.preferences) < 5:
            plan.preferences.append(
                Constraint(name=definition.code, value=matches[0].code)
            )
