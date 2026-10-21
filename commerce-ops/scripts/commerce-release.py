#!/usr/bin/env python3
"""Compatibility entry point for commerce-ops/scripts/release/commerce-release.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "release/commerce-release.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
