"""Compatibility command for :mod:`app.commerce_action_engine.application.knowledge_cli`."""

import asyncio

from app.commerce_action_engine.application.knowledge_cli import main

__all__ = ["main"]

if __name__ == "__main__":
    asyncio.run(main())
