"""Compatibility entry point for commerce-ops/scripts/demo/demo_presets.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "demo/demo_presets.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
