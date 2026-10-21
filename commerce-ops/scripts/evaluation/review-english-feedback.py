"""Review minimized operator-exported feedback offline; never publish a release."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import json
import os
import sys
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))
from app.commerce_action_engine.application.feedback_review import (
    FailureRecord,
    ReviewEvent,
    ReviewQueue,
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tenant", required=True, type=UUID)
    parser.add_argument("--queue", type=Path)
    parser.add_argument("--records", type=Path)
    parser.add_argument("--reviews", type=Path)
    parser.add_argument("--delete", action="append", default=[])
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    if args.output.exists():
        parser.error(
            "Output must be a new file; retain or delete old snapshots under your retention policy"
        )

    def read(path):
        if path.stat().st_size > 2_000_000:
            raise ValueError("Review input exceeds limit")
        return path.read_bytes()

    queue = (
        ReviewQueue.model_validate_json(read(args.queue))
        if args.queue
        else ReviewQueue(tenant_id=args.tenant)
    )
    if queue.tenant_id != args.tenant:
        raise ValueError("Tenant mismatch")
    result = queue.update(
        now=datetime.now(UTC),
        records=[
            FailureRecord.model_validate(r) for r in json.loads(read(args.records))
        ]
        if args.records
        else (),
        events=[ReviewEvent.model_validate(r) for r in json.loads(read(args.reviews))]
        if args.reviews
        else (),
        delete=args.delete,
    )
    with os.fdopen(
        os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w"
    ) as output:
        output.write(result.model_dump_json(indent=2) + "\n")
    print(
        f"{len(result.records)} records; {len(result.events)} review events; no publication"
    )


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError):
        raise SystemExit(
            "Review failed: check tenant, strict input schema, retention and review transitions"
        ) from None
