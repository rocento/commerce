"""Compatibility entry point for commerce-ops/scripts/local/local-demo-assistants-setup.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "local/local-demo-assistants-setup.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
