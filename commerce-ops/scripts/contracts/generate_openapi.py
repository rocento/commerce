"""Compatibility entry point; the contract is owned by api-gateway."""
import runpy
import sys
from pathlib import Path
owner = Path(__file__).resolve().parents[3] / "commerce-api/rocento-api/crates/api-gateway/openapi"
sys.path.insert(0, str(owner))
runpy.run_path(str(owner / "generate_openapi.py"), run_name="__main__")
