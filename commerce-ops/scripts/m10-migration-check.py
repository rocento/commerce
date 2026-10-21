"""Compatibility entry point for commerce-ops/scripts/checks/m10-migration-check.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "checks/m10-migration-check.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
