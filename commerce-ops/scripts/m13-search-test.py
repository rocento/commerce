"""Compatibility entry point for commerce-ops/scripts/checks/m13-search-test.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "checks/m13-search-test.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
