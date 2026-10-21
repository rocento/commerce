"""Turn-owned reservation state for the existing commerce read policy."""

from dataclasses import dataclass

from app.commerce_action_engine.shared.errors import ToolUnavailable


@dataclass
class CommerceReadBudget:
    """Count attempts, including failed reservations; operation limits stay unchanged."""

    calls: int = 0

    def reserve(self, limit: int = 4) -> None:
        self.calls += 1
        if self.calls > limit:
            raise ToolUnavailable()
