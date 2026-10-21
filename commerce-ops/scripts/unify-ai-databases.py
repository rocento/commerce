"""Compatibility entry point for commerce-ops/scripts/maintenance/unify-ai-databases.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "maintenance/unify-ai-databases.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
