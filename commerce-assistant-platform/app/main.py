"""Stable ASGI entry point for the Commerce Action Engine."""

from app.commerce_action_engine.application.main import app, create_app

__all__ = ["app", "create_app"]
