#!/usr/bin/env python3
"""Entry point for the isolated commerce reliability baseline."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parent))

from commerce_reliability import main

if __name__ == '__main__':
    raise SystemExit(main())
