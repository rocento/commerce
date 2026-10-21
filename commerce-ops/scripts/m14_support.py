"""Compatibility entry point for commerce-ops/scripts/release/m14_support.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "release/m14_support.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
