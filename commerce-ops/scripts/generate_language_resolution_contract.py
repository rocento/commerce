"""Compatibility entry point for commerce-ops/scripts/contracts/generate_language_resolution_contract.py."""
from pathlib import Path as _Path

_owner = _Path(__file__).resolve().parent / "contracts" / "generate_language_resolution_contract.py"
# Use this module's namespace to preserve imports and patched generator globals.
__file__ = str(_owner)
exec(compile(_owner.read_bytes(), __file__, "exec"), globals())
