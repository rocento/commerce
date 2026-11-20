#!/usr/bin/env python3
"""Compatibility entry point for the canonical deployment job controller."""
from pathlib import Path
import runpy


ROOT = Path(__file__).resolve().parents[4]
runpy.run_path(str(ROOT / 'commerce-ops/cloud/host/deployment_job.py'), run_name='__main__')
