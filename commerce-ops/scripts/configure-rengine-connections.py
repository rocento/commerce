"""Compatibility entry point for commerce-ops/scripts/local/configure-rengine-connections.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "local/configure-rengine-connections.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
