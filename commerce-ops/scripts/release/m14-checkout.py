"""Run the isolated M14 real checkout recovery matrix."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

from m14_checkout import main

if __name__ == '__main__':
    main()
