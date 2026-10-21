"""Compatibility entry point for commerce-ops/scripts/evaluation/english-plan-baseline.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "evaluation/english-plan-baseline.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
