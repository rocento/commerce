"""Operator-only validation/import for structured domain evidence; no activation."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import asyncio
import hashlib
import json
import os
import sys
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "commerce-assistant-platform"))
from app.commerce_action_engine.actions.domain_evidence.contracts import (
    DomainPack,
    ProductFact,
)
from app.commerce_action_engine.platform.domain_evidence import (
    attest_product,
    stage_pack,
)


def verified_pack(path: Path, sources_root: Path) -> DomainPack:
    if path.stat().st_size > 524288:
        raise ValueError("Domain pack exceeds import limit")
    pack = DomainPack.model_validate_json(path.read_text())
    for source in pack.sources:
        document = sources_root / source.document_ref
        if hashlib.sha256(document.read_bytes()).hexdigest() != source.document_sha256:
            raise ValueError(f"Source review changed: {source.id}")
    return pack


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["validate", "stage", "attest", "inspect"])
    parser.add_argument("--pack", type=Path)
    parser.add_argument("--sources-root", type=Path)
    parser.add_argument("--fact", type=Path)
    args = parser.parse_args()
    pack = None
    if args.command in {"validate", "stage"}:
        if not args.pack or not args.sources_root:
            parser.error("--pack and --sources-root are required")
        pack = verified_pack(args.pack, args.sources_root)
        if args.command == "validate":
            print(
                json.dumps(
                    {
                        "fingerprint": pack.fingerprint,
                        "profiles": len(pack.profiles),
                        "sources": len(pack.sources),
                    }
                )
            )
            return
    dsn = os.environ.get("DOMAIN_EVIDENCE_DATABASE_URL")
    if not dsn:
        parser.error("Set DOMAIN_EVIDENCE_DATABASE_URL using operator credentials")
    async with await psycopg.AsyncConnection.connect(
        dsn, row_factory=dict_row, autocommit=True
    ) as conn:
        if args.command == "stage":
            fingerprint = await stage_pack(conn, pack)
            print(json.dumps({"staged": fingerprint, "activated": False}))
        elif args.command == "attest":
            if not args.fact or args.fact.stat().st_size > 8192:
                parser.error(
                    "--fact requires one bounded, reviewed exact-product attestation"
                )
            fact = ProductFact.model_validate_json(args.fact.read_text())
            await attest_product(conn, fact)
            print(
                json.dumps(
                    {
                        "attested": str(fact.id),
                        "tenant": str(fact.tenant_id),
                        "product": str(fact.product_id),
                    }
                )
            )
        else:
            rows = await (
                await conn.execute("""SELECT r.fingerprint,r.revision,
                (SELECT count(*) FROM assistant.domain_sources s WHERE s.release_fingerprint=r.fingerprint) AS sources,
                (SELECT count(*) FROM assistant.domain_profiles p WHERE p.release_fingerprint=r.fingerprint) AS profiles,
                (SELECT count(*) FROM assistant.domain_bindings b WHERE b.release_fingerprint=r.fingerprint) AS bindings
                FROM assistant.domain_releases r ORDER BY r.created_at""")
            ).fetchall()
            print(json.dumps(rows))


if __name__ == "__main__":
    asyncio.run(main())
