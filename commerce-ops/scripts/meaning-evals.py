"""Compatibility entry point for commerce-ops/scripts/evaluation/meaning-evals.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "evaluation/meaning-evals.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
