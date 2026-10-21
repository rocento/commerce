"""Compatibility entry point for commerce-ops/scripts/local/native-preview-local-proxy.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "local/native-preview-local-proxy.py"
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
