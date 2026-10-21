"""Compatibility entry point for commerce-ops/scripts/evaluation/m07-discovery-evals.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "evaluation/m07-discovery-evals.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
