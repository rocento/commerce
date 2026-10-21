"""Compatibility import for the gateway-owned contract."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import runpy
from pathlib import Path
extend = runpy.run_path(str(Path(__file__).resolve().parents[3] / "commerce-api/rocento-api/crates/api-gateway/openapi/reporting_contract.py"))["extend"]
