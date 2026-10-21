"""Stable coded failure shared by engine boundaries."""


class RuntimeErrorCode(Exception):
    def __init__(self, code: str):
        self.code = code
        super().__init__(f"Agent request failed: {code}")


class ToolUnavailable(Exception):
    """A scoped commerce read or write did not return an available result."""


class ToolDenied(Exception):
    """A trusted commerce endpoint explicitly refused authorization (HTTP 403)."""

    completed_action: str | None = None

    @property
    def message(self) -> str:
        completed = {
            "cart_add": "The item was added to your cart, but wishlist removal was denied. ",
            "wishlist_add": "The item was saved to your wishlist, but cart removal was denied. ",
        }.get(self.completed_action or "", "")
        return (
            completed
            + "Rocento supports this action, but your current access does not allow it. Contact the store for help."
        )


class KnowledgeConflict(Exception):
    """Approved knowledge has competing sources; composition must abstain."""
