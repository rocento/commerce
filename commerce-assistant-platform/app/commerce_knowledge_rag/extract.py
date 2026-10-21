"""Bounded parser subprocess. Never exposed as an agent tool."""

import json
import resource
import sys


def main() -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (10, 10))
    # Linux production worker: bound decompression/parser allocation before importing parsers.
    if sys.platform == "linux":
        resource.setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))
    from app.commerce_knowledge_rag.service import extract

    try:
        data = sys.stdin.buffer.read(5_000_001)
        pages = extract(data, sys.argv[1])
        sys.stdout.write(json.dumps(pages))
    except Exception:  # noqa: BLE001 -- document/parser errors are private
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
