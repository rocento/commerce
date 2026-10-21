"""Compatibility command for :mod:`app.commerce_resolution_engine.providers.smoke`."""

import asyncio

from app.commerce_resolution_engine.contracts import ModelError
from app.commerce_resolution_engine.providers.smoke import (
    Check,
    configured_provider,
    main,
)

__all__ = ["Check", "configured_provider", "main"]

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except ModelError as error:
        raise SystemExit(str(error)) from None
