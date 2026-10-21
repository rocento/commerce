"""Restore only captured database dumps into a disposable, networkless container.

No production queries or writes, restored credentials, globals, configuration,
or customer row output. COPY records are counted as bytes, never reported.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
OLD = ROOT / "output/enterprise-knowledge-release-prep-20261010"
OUT = ROOT / "output/enterprise-knowledge-release-repair-20261010"
REPORT_PATH = OUT / "backup-restore-rehearsal.json"
BACKUP = json.loads((OLD / "rollback-backup.json").read_text())
BASELINE = json.loads((OLD / "production-baseline.json").read_text())
FILES = {row["name"]: row for row in BACKUP["files"]}
SSH = ["ssh", "-i", str(ROOT / "commerce-ops/deploy/aws-deploy/rocento.pem"), "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=20", "ubuntu@3.78.102.161"]
CONTAINER = "knowledge-backup-restore-" + uuid.uuid4().hex[:12]
IMAGE = "pgvector/pgvector:pg16"
assert not REPORT_PATH.exists(), "Evidence exists; do not overwrite a previous drill"
report = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
          "scope": "Captured production database dumps restored into a new local container with --network none; production and main local databases unchanged",
          "productionChanged": False, "mainLocalDatabaseChanged": False,
          "restoredGlobals": False, "restoredConfiguration": False,
          "sourceBackup": BACKUP["path"], "image": IMAGE,
          "container": CONTAINER, "databases": {}, "logHashes": {},
          "scriptSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest()}
created = False
error = None


def digest(data):
    return hashlib.sha256(data).hexdigest()


def command(args, *, label, stdin=None, input=None):
    result = subprocess.run(args, stdin=stdin, input=input, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, cwd=ROOT)
    report["logHashes"][label] = {"stdoutSha256": digest(result.stdout),
                                 "stderrSha256": digest(result.stderr),
                                 "exitCode": result.returncode}
    if result.returncode:
        # Error details can contain COPY records; leave them out of diagnostics.
        raise RuntimeError(f"{label} failed with exit code {result.returncode}; no row data emitted")
    return result.stdout


def sql(database, query, label):
    return command(["docker", "exec", "-i", CONTAINER, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, "-At"],
                   label=label, input=query.encode()).decode().strip()


def quote_identifier(value):
    return '"' + value.replace('"', '""') + '"'


def archived_counts(dump, database):
    counts = {}
    with dump.open("rb") as source, tempfile.TemporaryFile() as errors:
        task = subprocess.Popen(["docker", "exec", "-i", CONTAINER, "pg_restore", "--data-only", "--no-owner", "--no-privileges"],
                                stdin=source, stdout=subprocess.PIPE, stderr=errors)
        current = None
        output_hash = hashlib.sha256()
        for line in task.stdout:
            output_hash.update(line)
            if current is not None:
                if line.rstrip(b"\r\n") == b"\\.":
                    current = None
                else:
                    counts[current] += 1
                continue
            match = re.match(rb"COPY (.+?) \([^\n]*\) FROM stdin;\r?\n$", line)
            if match:
                current = match[1].decode("utf8")
                assert current not in counts, "Repeated COPY target needs an explicit review"
                counts[current] = 0
        code = task.wait()
        errors.seek(0)
        report["logHashes"][database + "-archive-counts"] = {"stdoutSha256": output_hash.hexdigest(), "stderrSha256": digest(errors.read()), "exitCode": code}
        if code:
            raise RuntimeError("Archive count projection failed without exposing row contents")
    assert counts, "The dump contains no table data projection"
    return counts


try:
    with tempfile.TemporaryDirectory(prefix="knowledge-backup-restore-", dir="/private/tmp") as temporary:
        private = Path(temporary)
        os.chmod(private, 0o700)
        dumps = {}
        for database in ("commerce_language", "assistant"):
            name = database + ".dump"
            path = private / name
            remote = BACKUP["path"] + "/" + name
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as target:
                fetched = subprocess.run(SSH + ["sudo -n cat -- " + shlex.quote(remote)], stdout=target, stderr=subprocess.PIPE, cwd=ROOT)
            report["logHashes"][database + "-download"] = {"stderrSha256": digest(fetched.stderr), "exitCode": fetched.returncode}
            assert fetched.returncode == 0, "Protected read-only backup transfer failed"
            hasher = hashlib.sha256()
            with path.open("rb") as body:
                for chunk in iter(lambda: body.read(1024 * 1024), b""):
                    hasher.update(chunk)
            assert path.stat().st_size == FILES[name]["bytes"], "Backup byte size changed"
            assert hasher.hexdigest() == FILES[name]["sha256"], "Backup SHA-256 changed"
            report["databases"][database] = {"dumpBytes": path.stat().st_size, "dumpSha256": hasher.hexdigest(), "capturedHashVerified": True, "fileMode": oct(path.stat().st_mode & 0o777)}
            dumps[database] = path
        command(["docker", "run", "-d", "--name", CONTAINER, "--network", "none", "--label", "commerce.knowledge.drill=backup-restore", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", IMAGE], label="container-create")
        created = True
        inspect = json.loads(command(["docker", "inspect", CONTAINER], label="container-inspect"))[0]
        assert inspect["HostConfig"]["NetworkMode"] == "none"
        assert not inspect["HostConfig"]["PortBindings"]
        report["imageId"] = inspect["Image"]
        report["externalNetworkDisabled"] = True
        for attempt in range(60):
            ready = subprocess.run(["docker", "exec", CONTAINER, "pg_isready", "-U", "postgres"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if ready.returncode == 0:
                break
            time.sleep(.5)
        else:
            raise RuntimeError("Isolated PostgreSQL did not become ready")
        version = sql("postgres", "SELECT current_setting('server_version_num');", "server-version")
        assert 160000 <= int(version) < 170000, "This drill requires PostgreSQL 16"
        report["postgresVersionNumber"] = int(version)
        for database, dump in dumps.items():
            with dump.open("rb") as source:
                schema = command(["docker", "exec", "-i", CONTAINER, "pg_restore", "--schema-only", "--no-owner", "--no-privileges"], label=database + "-schema", stdin=source).decode()
            # Policies can name a NOLOGIN runtime group even when ACL restoration
            # is disabled. Create only referenced group names, never logins.
            roles = set()
            for match in re.finditer(r"CREATE POLICY [\s\S]+?;", schema):
                target = re.search(r"\bTO\s+(.+?)\s+(?:USING|WITH CHECK)\b", match.group())
                if target:
                    roles.update(value.strip().strip('"') for value in target.group(1).split(","))
            roles.discard("PUBLIC")
            for role in sorted(roles):
                assert re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]{0,62}", role), "Unexpected policy role identifier"
                existing = sql("postgres", "SELECT count(*) FROM pg_roles WHERE rolname='" + role + "';", database + "-role-check-" + role)
                if existing == "0":
                    sql("postgres", "CREATE ROLE " + quote_identifier(role) + " NOLOGIN;", database + "-role-create-" + role)
            fixture = database + "_restore"
            sql("postgres", "CREATE DATABASE " + quote_identifier(fixture) + ";", database + "-create")
            expected_counts = archived_counts(dump, database)
            with dump.open("rb") as source:
                command(["docker", "exec", "-i", CONTAINER, "pg_restore", "--exit-on-error", "--no-owner", "--no-privileges", "-U", "postgres", "-d", fixture], label=database + "-restore", stdin=source)
            actual_counts = {}
            for table, count in expected_counts.items():
                assert re.fullmatch(r'[a-zA-Z0-9_".]+', table), "Unexpected archived table identifier"
                actual_counts[table] = int(sql(fixture, "SELECT count(*) FROM " + table + ";", database + "-count-" + table))
                assert actual_counts[table] == count, "Restored table count differs from archived COPY record count: " + table
            integrity = json.loads(sql(fixture, "SELECT json_build_object('unvalidatedConstraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND NOT c.convalidated),'invalidIndexes',(SELECT count(*) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND NOT i.indisvalid),'constraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')));", database + "-integrity"))
            assert integrity["unvalidatedConstraints"] == 0
            assert integrity["invalidIndexes"] == 0
            report["databases"][database].update({"restoreExitCode": 0, "policyNoLoginRoles": sorted(roles), "tableCount": len(actual_counts), "tableRowCounts": actual_counts, "archivedTableCountsMatch": True, "integrity": integrity})
            if database == "commerce_language":
                row = json.loads(sql(fixture, "SELECT json_build_object('id',d.id,'fingerprint',d.fingerprint,'artifact',d.artifact,'archive',encode(d.corpus_gzip,'base64')) FROM release.channels c JOIN release.dictionaries d ON d.id=c.release_id WHERE c.channel='production';", "baseline-release-identity"))
                assert row["id"] == BACKUP["baselineReleaseId"] == BASELINE["release"]["id"]
                assert row["fingerprint"] == BASELINE["release"]["fingerprint"]
                assert row["artifact"] == BASELINE["release"]["artifact"]
                import base64
                corpus = gzip.decompress(base64.b64decode(row["archive"]))
                assert digest(corpus) == BASELINE["release"]["corpusSha256"]
                report["baselineIdentity"] = {"releaseId": row["id"], "fingerprint": row["fingerprint"], "artifactDeepEqualToCaptured": True, "artifactSha256": BASELINE["release"]["artifactSha256"], "corpusSha256": digest(corpus), "corpusCases": len(corpus.splitlines())}
        report["status"] = "passed_production_backup_full_restore"
    report["downloadedDumpsRemoved"] = True
except Exception as caught:
    error = caught
    report["status"] = "restore_rehearsal_failed"
    report["error"] = str(caught)
finally:
    if created:
        removed = subprocess.run(["docker", "rm", "-fv", CONTAINER], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        report["containerRemoved"] = removed.returncode == 0
        report["logHashes"]["container-remove"] = {"stdoutSha256": digest(removed.stdout), "stderrSha256": digest(removed.stderr), "exitCode": removed.returncode}
        if removed.returncode:
            error = RuntimeError("Isolated container cleanup failed")
            report["status"] = "cleanup_failed"
    else:
        report["containerRemoved"] = True
    report["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    OUT.mkdir(exist_ok=True)
    fd = os.open(REPORT_PATH, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as evidence:
        json.dump(report, evidence, indent=2)
        evidence.write("\n")
print(json.dumps({"status": report["status"], "containerRemoved": report["containerRemoved"], "downloadedDumpsRemoved": report.get("downloadedDumpsRemoved", False), "databases": {name: {"tableCount": value.get("tableCount"), "integrity": value.get("integrity")} for name, value in report["databases"].items()}}))
if error:
    raise error
