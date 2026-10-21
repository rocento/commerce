#!/usr/bin/env python3
"""Compatibility entry point for commerce-ops/scripts/demo/expand-electronics-catalog.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "demo/expand-electronics-catalog.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
