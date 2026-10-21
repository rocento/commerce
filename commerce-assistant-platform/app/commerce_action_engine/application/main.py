"""Stable ASGI entry point; application wiring lives in bootstrap."""

from app.commerce_action_engine.application.bootstrap import create_app

__all__ = ["app", "create_app"]

app = create_app()
