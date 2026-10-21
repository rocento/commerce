"""Failure types for the retained direct-reorder transport."""


class ReorderRejected(Exception):
    """The server rejected the request before committing an order."""


class ReorderUncertain(Exception):
    """No trustworthy receipt arrived; do not retry with a fresh request identifier."""
