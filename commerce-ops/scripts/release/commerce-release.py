#!/usr/bin/env python3

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

from commerce_release import main

if __name__ == '__main__':
    raise SystemExit(main())
