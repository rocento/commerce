#!/usr/bin/env python3
"""Compatibility entry point for the host publication configuration renderer."""
from pathlib import Path
import runpy

root = next(parent for parent in Path(__file__).resolve().parents
            if (parent / 'commerce-api/rocento-api/Cargo.toml').is_file())
runpy.run_path(str(root / 'commerce-ops/cloud/host/publication.py'), run_name='__main__')
