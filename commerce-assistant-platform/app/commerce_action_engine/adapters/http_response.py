"""Shared commerce HTTP status mapping without leaking upstream denial bodies."""

import httpx

from app.commerce_action_engine.shared.errors import ToolDenied


def check_response(response: httpx.Response) -> None:
    if response.status_code == 403:
        raise ToolDenied()  # Do not expose the upstream body or retry a denied request.
    response.raise_for_status()
