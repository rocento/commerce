"""Update the bootstrap recognition seed from neutral comparison contracts."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))

from app.commerce_contracts.comparisons import (
    COMPARISON_SYMBOLS,
    comparison_phrases,
)


def render() -> dict[str, str]:
    return {
        phrase: COMPARISON_SYMBOLS[operator]
        for phrase, operator in comparison_phrases().items()
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    path = ROOT / "commerce-assistant-platform/app/commerce_language_engine/seeds/recognition-rules.en.json"
    seed = json.loads(path.read_text())
    entry = seed["entries"]["comparison-operators.comparisonOperators.value.1"]
    expected = render()
    if args.check:
        if entry["value"] != expected:
            print("Comparison seed is stale; run the generator.")
            return 1
        print("Comparison seed matches the neutral contract.")
    else:
        entry["value"] = expected
        path.write_text(json.dumps(seed, indent=2, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
