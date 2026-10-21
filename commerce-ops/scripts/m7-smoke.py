"""Compatibility entry point for commerce-ops/scripts/checks/m7-smoke.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "checks/m7-smoke.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
