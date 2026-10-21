"""Compatibility entry point for commerce-ops/scripts/demo/m8_db.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "demo/m8_db.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
