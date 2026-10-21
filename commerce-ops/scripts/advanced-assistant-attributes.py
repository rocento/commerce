#!/usr/bin/env python3
"""Compatibility entry point for commerce-ops/scripts/demo/advanced-assistant-attributes.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "demo/advanced-assistant-attributes.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
