#!/usr/bin/env python3
"""Compatibility entry point for commerce-ops/scripts/demo/history/add-meat-poultry-products-20261004.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "demo/history/add-meat-poultry-products-20261004.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
