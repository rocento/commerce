"""Compatibility entry point for commerce-ops/scripts/generation/generate_ai_capabilities.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "generation/generate_ai_capabilities.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
