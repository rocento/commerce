"""Operator-only, staged AI database consolidation on the production host.

prepare rehearses restores without changing consumers. cutover repeats the copy
with writers stopped; cleanup requires successful cutover evidence and live checks.
Customer records and verification hashes remain on the production host.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))


import argparse
import fcntl
import json
import os
import secrets
import subprocess
from datetime import datetime, timezone
from pathlib import Path

STORES = ("grocery", "jewelry", "electronics", "pharmacy")
TARGET = "rocento-ai-shared-ai-postgres-1"
ROOT = Path(__file__).resolve().parents[3]
STATE = ROOT / "deploy/ec2/shared-ai"
TABLES = (
    "conversations",
    "turns",
    "metrics",
    "knowledge_sources",
    "knowledge_chunks",
    "messages",
    "request_revisions",
    "compound_plans",
    "tracking_reports",
)


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def sql(container, db, statement, user="ai_owner"):
    result = run(
        [
            "docker",
            "exec",
            "-i",
            container,
            "psql",
            "-X",
            "-U",
            user,
            "-d",
            db,
            "-At",
            "-v",
            "ON_ERROR_STOP=1",
        ],
        input=statement,
        text=True,
        capture_output=True,
    )
    return result.stdout.strip()


def query(container, db, statement, user="ai_owner"):
    return json.loads(
        sql(
            container,
            db,
            f"SELECT coalesce(json_agg(q),'[]'::json) FROM ({statement}) q;",
            user,
        )
    )


def write_secret(path, value):
    if path.exists():
        return path.read_text().strip()
    with open(path, "x", opener=lambda p, flags: os.open(p, flags, 0o600)) as out:
        out.write(value + "\n")
    return value


def compose(store, *args):
    run(["bash", str(ROOT / "deploy/ec2/server/ec2-compose.sh"), store, *args], cwd=ROOT)


def target_psql(db, content, role=None):
    args = [
        "docker",
        "exec",
        "-i",
        TARGET,
        "psql",
        "-X",
        "-U",
        "ai_owner",
        "-d",
        db,
        "-v",
        "ON_ERROR_STOP=1",
        "--single-transaction",
    ]
    if role:
        args += ["-c", f"SET ROLE {role}"]
    args += ["-f", "-"]
    run(args, input=content, capture_output=True)


def restore(path, db, *, data=False, role=None):
    # pg_restore runs inside the server; no backup payload leaves this host.
    args = [
        "docker",
        "exec",
        "-i",
        TARGET,
        "pg_restore",
        "--file=-",
        "--no-owner",
        "--no-acl",
        "--exit-on-error",
    ]
    if data:
        args += ["--data-only", "--disable-triggers"]
        for table in TABLES:
            args += ["--table", table]
    with path.open("rb") as stream:
        dump = run(args, stdin=stream, capture_output=True).stdout
    target_psql(db, dump, role)


def snapshot(backup):
    result = {}
    expected = json.loads(
        (
            ROOT / "commerce-assistant-platform/app/commerce_language_engine/data/compiled.json"
        ).read_text()
    )["generationFingerprint"]
    for store in STORES:
        a = f"rocento-{store}-ai-postgres-1"
        l = f"rocento-{store}-postgres-1"
        tenant = sql(a, "assistant", "SELECT tenant_id FROM assistant.deployment")
        # Reserved documents was retired after migration 010. Old installations
        # may still contain the empty table; never silently omit real records.
        if (
            sql(a, "assistant", "SELECT to_regclass('assistant.documents') IS NOT NULL") == "t"
            and int(sql(a, "assistant", "SELECT count(*) FROM assistant.documents"))
        ):
            raise RuntimeError(f"{store} has reserved documents requiring reconciliation")
        release = query(
            l,
            "commerce_language",
            "SELECT d.fingerprint,d.artifact FROM release.channels ch JOIN release.dictionaries d ON d.id=ch.release_id WHERE ch.channel='production'",
            "commerce",
        )[0]
        if release["fingerprint"] != expected:
            raise RuntimeError(
                f"{store} does not have the latest packaged language release"
            )
        result[store] = {
            "tenant": tenant,
            "fingerprint": expected,
            "counts": {
                t: int(sql(a, "assistant", f"SELECT count(*) FROM assistant.{t}"))
                for t in TABLES
            },
        }
        for kind, container, db, user in [
            ("assistant", a, "assistant", "ai_owner"),
            ("language", l, "commerce_language", "commerce"),
        ]:
            path = backup / f"{store}-{kind}.dump"
            with open(
                path, "xb", opener=lambda p, flags: os.open(p, flags, 0o600)
            ) as out:
                run(
                    [
                        "docker",
                        "exec",
                        container,
                        "pg_dump",
                        "-U",
                        user,
                        "-d",
                        db,
                        "-Fc",
                    ],
                    stdout=out,
                )
        print(
            f"[OK] {store}: latest language release and both database backups",
            flush=True,
        )
    assert len({v["tenant"] for v in result.values()}) == 4
    (backup / "inventory.json").write_text(json.dumps(result, indent=2))
    return result


def digest(container, db, table, where="", user="ai_owner"):
    # Return a scalar to this server process only; never export hashes in reports.
    return sql(
        container,
        db,
        f"SELECT count(*)||':'||coalesce(md5(string_agg(h,'' ORDER BY h)),'empty') FROM (SELECT md5(row_to_json(t)::text) h FROM {table} t {where}) q",
        user,
    )


def provision():
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(STATE, 0o700)
    write_secret(STATE / "admin-password", secrets.token_hex(32))
    run(
        [
            "docker",
            "compose",
            "-p",
            "rocento-ai",
            "-f",
            "commerce-ops/compose/compose.ai-shared.yaml",
            "up",
            "-d",
            "--no-build",
            "--wait",
            "--wait-timeout",
            "120",
        ],
        cwd=ROOT,
    )
    existing = sql(
        TARGET, "postgres", "SELECT count(*) FROM pg_roles WHERE rolname='ai_runtime'"
    )
    if existing == "0":
        sql(
            TARGET,
            "postgres",
            "CREATE ROLE ai_runtime NOLOGIN; CREATE ROLE ai_knowledge_writer NOLOGIN; CREATE ROLE ai_language_runtime NOLOGIN; CREATE ROLE language_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;",
        )
    owner = write_secret(STATE / "language-owner-password", secrets.token_hex(32))
    sql(TARGET, "postgres", f"ALTER ROLE language_owner PASSWORD {literal(owner)};")
    write_secret(
        STATE / "language-owner.env",
        f"DATABASE_URL=postgres://language_owner:{owner}@shared-ai-postgres:5432/commerce_language\nLANGUAGE_ENGINE_ADMIN_DATABASE=postgres",
    )


def reset_candidates():
    if any((ROOT / f"deploy/ec2/{s}-shared-ai.env").exists() for s in STORES):
        raise RuntimeError("Refusing to reset a database with enabled consumers")
    for db in ("assistant", "commerce_language"):
        sql(TARGET, "postgres", f"DROP DATABASE IF EXISTS {db};")
        sql(
            TARGET,
            "postgres",
            f"CREATE DATABASE {db} OWNER "
            + ("language_owner" if db == "commerce_language" else "ai_owner")
            + ";",
        )


def merge(backup, inventory):
    reset_candidates()
    restore(backup / "grocery-assistant.dump", "assistant")
    # Schema privileges are explicit because backups are restored without ACLs.
    sql(
        TARGET,
        "assistant",
        "GRANT USAGE ON SCHEMA assistant,public TO ai_runtime,ai_knowledge_writer; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA assistant TO ai_runtime; REVOKE UPDATE ON assistant.tracking_reports FROM ai_runtime; REVOKE ALL ON assistant.deployment FROM ai_runtime; GRANT SELECT ON assistant.deployment TO ai_runtime; REVOKE ALL ON assistant.knowledge_sources,assistant.knowledge_chunks FROM ai_runtime; GRANT SELECT ON assistant.knowledge_sources,assistant.knowledge_chunks TO ai_runtime; GRANT SELECT ON assistant.deployment TO ai_knowledge_writer; GRANT SELECT,INSERT,UPDATE,DELETE ON assistant.knowledge_sources,assistant.knowledge_chunks TO ai_knowledge_writer; REVOKE CREATE ON SCHEMA public FROM PUBLIC; REVOKE ALL ON FUNCTION assistant.purge_expired(uuid) FROM PUBLIC; GRANT EXECUTE ON FUNCTION assistant.purge_expired(uuid) TO ai_runtime;",
    )
    for store in STORES[1:]:
        restore(backup / f"{store}-assistant.dump", "assistant", data=True)
    restore(
        backup / "grocery-language.dump", "commerce_language", role="language_owner"
    )
    target_psql(
        "assistant", (ROOT / "commerce-ops/deploy/assistant/shared-tenants.sql").read_bytes()
    )
    # Archive only differences from the canonical language projection. These
    # operator-only records preserve each source's release/evaluation history.
    sql(
        TARGET,
        "commerce_language",
        "CREATE SCHEMA migration_archive; CREATE TABLE migration_archive.source_rows(source_store text NOT NULL, source_table text NOT NULL, payload jsonb NOT NULL); REVOKE ALL ON SCHEMA migration_archive FROM PUBLIC;",
    )
    for store in STORES[1:]:
        temporary = f"verify_language_{store}"
        sql(TARGET, "postgres", f"CREATE DATABASE {temporary};")
        try:
            restore(backup / f"{store}-language.dump", temporary)
            tables = query(
                TARGET,
                temporary,
                "SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')",
            )
            for item in tables:
                table = f'"{item["schemaname"]}"."{item["tablename"]}"'
                if digest(TARGET, temporary, table) == digest(
                    TARGET, "commerce_language", table
                ):
                    continue
                original = query(
                    TARGET, temporary, f"SELECT row_to_json(t) AS row FROM {table} t"
                )
                if table == '"context"."sessions"':
                    for record in original:
                        payload = literal(json.dumps(record["row"]))
                        sql(
                            TARGET,
                            "commerce_language",
                            f"INSERT INTO context.sessions SELECT * FROM json_populate_record(NULL::context.sessions,{payload}::json) ON CONFLICT DO NOTHING;",
                        )
                # Preserve differing source rows exactly for audit/rollback; no
                # activation or projection overwrite is inferred from timestamps.
                if original:
                    lines = "\n".join(
                        f"INSERT INTO migration_archive.source_rows VALUES ({literal(store)},{literal(table)},{literal(json.dumps(r['row']))}::jsonb);"
                        for r in original
                    )
                    target_psql("commerce_language", lines.encode())
        finally:
            sql(TARGET, "postgres", f"DROP DATABASE {temporary};")
    target_psql(
        "commerce_language",
        (ROOT / "commerce-ops/deploy/assistant/shared-language-tenants.sql").read_bytes(),
    )
    for store, info in inventory.items():
        role = f"ai_runtime_{store}"
        old_password = (
            (ROOT / f"deploy/ec2/assistant/{store}/store-runtime-password")
            .read_text()
            .strip()
        )
        lang_role = f"language_{store}"
        lang_password = write_secret(
            STATE / f"{store}-language-password", secrets.token_hex(32)
        )
        for name, password, group in [
            (role, old_password, "ai_runtime"),
            (lang_role, lang_password, "ai_language_runtime"),
        ]:
            if (
                sql(
                    TARGET,
                    "postgres",
                    f"SELECT count(*) FROM pg_roles WHERE rolname={literal(name)}",
                )
                == "0"
            ):
                sql(
                    TARGET,
                    "postgres",
                    f"CREATE ROLE {name} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS IN ROLE {group};",
                )
            sql(
                TARGET,
                "postgres",
                f"ALTER ROLE {name} PASSWORD {literal(password)}; ALTER ROLE {name} SET statement_timeout='5s'; ALTER ROLE {name} SET idle_in_transaction_session_timeout='5s'; ALTER ROLE {name} CONNECTION LIMIT 16;",
            )
        sql(
            TARGET,
            "assistant",
            f"INSERT INTO assistant.tenant_logins VALUES ({literal(role)},{literal(info['tenant'])},{literal(store)});",
        )
        sql(
            TARGET,
            "commerce_language",
            f"INSERT INTO context.tenant_logins VALUES ({literal(lang_role)},{literal(info['tenant'])},{literal(store)});",
        )
        write_secret(
            STATE / f"{store}-consumer.env",
            f"SHARED_AI_STORE_USER={role}\nSHARED_LANGUAGE_DATABASE_URL=postgres://{lang_role}:{lang_password}@shared-ai-postgres:5432/commerce_language",
        )
    sql(
        TARGET,
        "postgres",
        "REVOKE CONNECT ON DATABASE assistant FROM PUBLIC; GRANT CONNECT ON DATABASE assistant TO ai_runtime,ai_knowledge_writer; REVOKE CONNECT ON DATABASE commerce_language FROM PUBLIC; GRANT CONNECT ON DATABASE commerce_language TO ai_language_runtime,language_owner;",
    )
    # Restore-time grants are explicit; a runtime must never become table owner.
    sql(
        TARGET, "assistant", "REVOKE CREATE ON SCHEMA assistant FROM PUBLIC,ai_runtime;"
    )
    verify_copy(backup, inventory)


def verify_copy(backup, inventory):
    for store, info in inventory.items():
        temporary = f"verify_assistant_{store}"
        sql(TARGET, "postgres", f"CREATE DATABASE {temporary};")
        restore(backup / f"{store}-assistant.dump", temporary)
        for table in TABLES:
            source = digest(TARGET, temporary, f"assistant.{table}")
            target = digest(
                TARGET,
                "assistant",
                f"assistant.{table}",
                f"WHERE tenant_id={literal(info['tenant'])}::uuid",
            )
            if source != target:
                raise RuntimeError(f"{store} assistant.{table} copy differs")
            info["counts"][table] = int(
                sql(TARGET, temporary, f"SELECT count(*) FROM assistant.{table}")
            )
        sql(TARGET, "postgres", f"DROP DATABASE {temporary};")
        role = f"ai_runtime_{store}"
        other = inventory[next(s for s in STORES if s != store)]["tenant"]
        own = sql(
            TARGET,
            "assistant",
            f"SET SESSION AUTHORIZATION {role}; SET assistant.tenant={literal(info['tenant'])}; SELECT count(*) FROM assistant.metrics;",
        ).splitlines()[-1]
        foreign = sql(
            TARGET,
            "assistant",
            f"SET SESSION AUTHORIZATION {role}; SET assistant.tenant={literal(other)}; SELECT count(*) FROM assistant.metrics;",
        ).splitlines()[-1]
        assert int(own) == info["counts"]["metrics"] and foreign == "0", (
            f"{store} isolation failed"
        )
        print(
            f"[OK] {store}: every assistant row verified; foreign tenant invisible",
            flush=True,
        )
    source = query(
        "rocento-grocery-postgres-1",
        "commerce_language",
        "SELECT d.artifact FROM release.channels c JOIN release.dictionaries d ON d.id=c.release_id WHERE c.channel='production'",
        "commerce",
    )
    target = query(
        TARGET,
        "commerce_language",
        "SELECT d.artifact FROM release.channels c JOIN release.dictionaries d ON d.id=c.release_id WHERE c.channel='production'",
    )
    assert source == target, "Latest language artifact changed during copy"
    (backup / "inventory.json").write_text(json.dumps(inventory, indent=2))
    (backup / "verified.json").write_text(
        json.dumps(
            {
                "assistant_rows_verified": True,
                "latest_language_verified": True,
                "tenant_isolation_verified": True,
                "fingerprint": inventory["grocery"]["fingerprint"],
            },
            indent=2,
        )
    )


def live_checks():
    for store in STORES:
        run(
            [
                "docker",
                "exec",
                f"rocento-{store}-ai-service-1",
                "python",
                "-c",
                "import json,urllib.request; from app.commerce_action_engine.actions.shopping.context import _published_sentence_rules; assert _published_sentence_rules(); r=urllib.request.urlopen('http://localhost:8000/ready'); assert r.status==200; print('Python health and published rules verified')",
            ]
        )
        run(
            [
                "docker",
                "exec",
                f"rocento-{store}-commerce-language-engine-1",
                "node",
                "--input-type=module",
                "-e",
                "const r=await fetch('http://localhost:3000/api/ready');if(!r.ok)throw Error('Language not ready');const d=await r.json();console.log(JSON.stringify({status:d.status,fingerprint:d.generationFingerprint}));",
            ]
        )
        inspect = json.loads(
            subprocess.check_output(
                [
                    "docker",
                    "inspect",
                    f"rocento-{store}-ai-service-1",
                    f"rocento-{store}-commerce-language-engine-1",
                ],
                text=True,
            )
        )
        assert all(c["State"]["Health"]["Status"] == "healthy" for c in inspect)
        ai = dict(v.split("=", 1) for v in inspect[0]["Config"]["Env"] if "=" in v)
        language = dict(
            v.split("=", 1) for v in inspect[1]["Config"]["Env"] if "=" in v
        )
        assert (
            ai.get("AI_STORE_HOST") == "shared-ai-postgres"
            and ai.get("AI_STORE_USER") == f"ai_runtime_{store}"
        )
        assert "@shared-ai-postgres:5432/commerce_language" in language.get(
            "DATABASE_URL", ""
        )
        print(f"[OK] {store}: both live services use shared databases", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=("prepare", "cutover", "cleanup"))
    args = parser.parse_args()
    if os.geteuid() != 0 or ROOT != Path("/opt/rocento"):
        parser.error("Run as root from /opt/rocento on the production host")
    os.umask(0o077)
    with (ROOT / "deploy/ec2/setup.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.mode == "cleanup":
            complete = STATE / "cutover.json"
            if not complete.exists():
                raise RuntimeError("No verified cutover evidence")
            evidence = json.loads(complete.read_text())
            backup = Path(evidence["backup"])
            assert (backup / "verified.json").exists() and all(
                (backup / f"{s}-{k}.dump").stat().st_size > 0
                for s in STORES
                for k in ("assistant", "language")
            )
            live_checks()
            for store in STORES:
                container = f"rocento-{store}-ai-postgres-1"
                # Remove only the duplicate AI container and its dedicated volume.
                if (
                    subprocess.run(
                        ["docker", "inspect", container],
                        capture_output=True,
                        check=False,
                    ).returncode
                    == 0
                ):
                    run(["docker", "rm", "-f", container])
                volume = f"rocento-{store}_ai-data"
                if (
                    subprocess.run(
                        ["docker", "volume", "inspect", volume],
                        capture_output=True,
                        check=False,
                    ).returncode
                    == 0
                ):
                    run(["docker", "volume", "rm", volume])
                sql(
                    f"rocento-{store}-postgres-1",
                    "postgres",
                    "DROP DATABASE IF EXISTS commerce_language;",
                    "commerce",
                )
                print(
                    f"[OK] {store}: duplicate AI databases removed; commerce database retained",
                    flush=True,
                )
            (STATE / "cleanup.json").write_text(
                json.dumps({"backup": str(backup), "removed": list(STORES)}, indent=2)
            )
            return
        if any((ROOT / f"deploy/ec2/{s}-shared-ai.env").exists() for s in STORES):
            raise RuntimeError(
                "Some shared consumers are already enabled; do not overwrite live data"
            )
        if args.mode == "cutover" and not (STATE / "rehearsal.json").exists():
            raise RuntimeError("A successful rehearsal is required before cutover")
        provision()
        backup = Path("/var/backups/rocento") / (
            "ai-unification-"
            + args.mode
            + "-"
            + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        )
        backup.mkdir(mode=0o700)
        stopped = False
        committed = False
        try:
            if args.mode == "cutover":
                stopped = True
                for store in STORES:
                    compose(store, "stop", "assistant-ingress")
                for store in STORES:
                    compose(
                        store,
                        "stop",
                        "-t",
                        "35",
                        "ai-service",
                        "commerce-language-engine",
                    )
            inventory = snapshot(backup)
            merge(backup, inventory)
            if args.mode == "prepare":
                (STATE / "rehearsal.json").write_text(
                    json.dumps({"backup": str(backup)}, indent=2)
                )
                print(
                    "[OK] Rehearsal complete. Production consumers are unchanged.",
                    flush=True,
                )
                return
            for store in STORES:
                (ROOT / f"deploy/ec2/{store}-shared-ai.env").write_text(
                    (STATE / f"{store}-consumer.env").read_text()
                )
            for store in STORES:
                compose(
                    store,
                    "up",
                    "-d",
                    "--no-deps",
                    "--no-build",
                    "--wait",
                    "--wait-timeout",
                    "300",
                    "commerce-language-engine",
                    "ai-service",
                )
            live_checks()
            (STATE / "cutover.json").write_text(
                json.dumps(
                    {
                        "backup": str(backup),
                        "fingerprint": inventory["grocery"]["fingerprint"],
                    },
                    indent=2,
                )
            )
            committed = True
            for store in STORES:
                compose(store, "start", "assistant-ingress")
            for store in STORES:
                run(["docker", "stop", f"rocento-{store}-ai-postgres-1"])
            print(
                "[OK] Cutover verified. Duplicate databases are stopped and retained until cleanup.",
                flush=True,
            )
        except BaseException:
            if stopped and not committed:
                # Before any cleanup, the original databases remain authoritative
                # rollback copies. Stop all consumers before restoring routing.
                for store in STORES:
                    subprocess.run(
                        [
                            "docker",
                            "stop",
                            f"rocento-{store}-ai-service-1",
                            f"rocento-{store}-commerce-language-engine-1",
                        ],
                        check=False,
                    )
                    (ROOT / f"deploy/ec2/{store}-shared-ai.env").unlink(missing_ok=True)
                for store in STORES:
                    compose(
                        store,
                        "up",
                        "-d",
                        "--no-deps",
                        "--no-build",
                        "--wait",
                        "--wait-timeout",
                        "300",
                        "commerce-language-engine",
                        "ai-service",
                    )
                for store in STORES:
                    compose(store, "start", "assistant-ingress")
            raise


if __name__ == "__main__":
    main()
