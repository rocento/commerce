"""Same-host restore drill; run via sudo python3 on the verified production host.

The only host data mounts are the two read-only captured dumps. Restored data
never leave this host. Output contains aggregate counts and known release hashes.
"""
import base64
import gzip
import hashlib
import json
from pathlib import Path
import re
import shutil
import signal
import subprocess
import tempfile
import time
import uuid

BACKUP = Path("/var/backups/rocento/enterprise-knowledge-prepublish-20261010.Y4C2AzBz")
IMAGE = "sha256:81a5ee0bc4621f0f5e19cff779ae990b44eb530c8f5d1ebc06ea5750be1c8b4a"
EXPECTED = {
    "commerce_language": {"bytes": 75640777, "sha256": "85a3617335dd4b85d593910101b6990e043511eb72d185c95240f699b267a642"},
    "assistant": {"bytes": 138266, "sha256": "2399f6b556de1430e017aab4d1c3eaef38b2bf4677e966bf24301f1eada90fbb"},
}
IDENTITY = {"releaseId": "80882336-f1a0-4cdf-bac3-1eebaccc58ea", "fingerprint": "27f4c21a9b5d974fc66dca1460fd6805f4c358e68e89e4d95ca0c088d93d26d4", "artifactSha256": "21ea9e711836e5f9f0c8d1355b2906a57e4740abd640ff74b470de7864ff95a7", "corpusSha256": "fe898fcdafd7c189d5226079558071348ecb8b941f1c28090b37c92df5dbaf74"}
SUFFIX = uuid.uuid4().hex[:12]
CONTAINER, VOLUME = "knowledge-restore-drill-" + SUFFIX, "knowledge-restore-drill-data-" + SUFFIX
report = {"startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "scope": "Full restore into a new resource-limited networkless container on the existing production host; restored data remain on that host", "productionDatabasesChanged": False, "productionContainersChanged": False, "backupPayloadExported": False, "restoredGlobals": False, "restoredConfiguration": False, "sourceBackup": str(BACKUP), "imageId": IMAGE, "container": CONTAINER, "volume": VOLUME, "databases": {}, "logHashes": {}}
created_container = created_volume = False
error = None


def digest(value):
    return hashlib.sha256(value).hexdigest()


def command(args, label, *, input=None):
    result = subprocess.run(args, input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    report["logHashes"][label] = {"exitCode": result.returncode, "stdoutSha256": digest(result.stdout), "stderrSha256": digest(result.stderr)}
    if result.returncode:
        raise RuntimeError(label + " failed; potentially sensitive row details withheld")
    return result.stdout


def sql(database, query, label):
    return command(["docker", "exec", "-i", CONTAINER, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", database, "-At"], label, input=query.encode()).decode().strip()


def archived_counts(database):
    result, active, hasher = {}, None, hashlib.sha256()
    with tempfile.TemporaryFile() as errors:
        task = subprocess.Popen(["docker", "exec", CONTAINER, "pg_restore", "--data-only", "--no-owner", "--no-privileges", "--file=-", "/restore/" + database + ".dump"], stdout=subprocess.PIPE, stderr=errors)
        for line in task.stdout:
            hasher.update(line)
            if active is not None:
                if line.rstrip(b"\r\n") == b"\\.":
                    active = None
                else:
                    result[active] += 1
                continue
            match = re.match(rb"COPY (.+?) \([^\n]*\) FROM stdin;\r?\n$", line)
            if match:
                active = match[1].decode()
                assert active not in result, "Repeated COPY target requires review"
                result[active] = 0
        code = task.wait()
        errors.seek(0)
        report["logHashes"][database + "-archive-counts"] = {"exitCode": code, "stdoutSha256": hasher.hexdigest(), "stderrSha256": digest(errors.read())}
        assert code == 0, "Archive aggregate-count projection failed"
    assert result, "Empty table-data projection"
    return result


def stop(signum, _frame):
    raise RuntimeError("Drill interrupted by signal " + str(signum))


for caught_signal in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
    signal.signal(caught_signal, stop)

try:
    memory = {line.split(":")[0]: int(line.split()[1]) * 1024 for line in Path("/proc/meminfo").read_text().splitlines() if line.startswith(("MemAvailable:", "MemTotal:"))}
    report["capacityBefore"] = {"memory": memory, "dockerDiskFreeBytes": shutil.disk_usage("/var/lib/docker").free}
    assert memory["MemAvailable"] >= 2 * 1024**3, "Below the agreed 2 GiB available-memory threshold"
    assert report["capacityBefore"]["dockerDiskFreeBytes"] >= 3 * 1024**3, "Below the agreed 3 GiB free-disk threshold"
    command(["docker", "image", "inspect", IMAGE], "image-availability")
    for name, expected in EXPECTED.items():
        path = BACKUP / (name + ".dump")
        assert path.stat().st_size == expected["bytes"], "Captured backup size differs"
        hasher = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                hasher.update(chunk)
        assert hasher.hexdigest() == expected["sha256"], "Captured backup hash differs"
        report["databases"][name] = {"dumpBytes": path.stat().st_size, "dumpSha256": hasher.hexdigest(), "capturedHashVerified": True}
    command(["docker", "volume", "create", "--label", "commerce.knowledge.drill=backup-restore", VOLUME], "create-volume")
    created_volume = True
    args = ["docker", "run", "-d", "--name", CONTAINER, "--network", "none", "--cpus", "0.5", "--memory", "512m", "--memory-swap", "1g", "--pids-limit", "128", "--label", "commerce.knowledge.drill=backup-restore", "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "--mount", "type=volume,source=" + VOLUME + ",target=/var/lib/postgresql/data"]
    for name in EXPECTED:
        args += ["--mount", "type=bind,source=" + str(BACKUP / (name + ".dump")) + ",target=/restore/" + name + ".dump,readonly"]
    args.append(IMAGE)
    command(args, "create-container")
    created_container = True
    inspect = json.loads(command(["docker", "inspect", CONTAINER], "inspect-isolation"))[0]
    host = inspect["HostConfig"]
    assert host["NetworkMode"] == "none" and not host["PortBindings"]
    assert host["Memory"] == 512 * 1024**2 and host["MemorySwap"] == 1024**3 and host["NanoCpus"] == 500000000
    binds = [mount for mount in inspect["Mounts"] if mount["Type"] == "bind"]
    assert len(binds) == 2 and all(not mount["RW"] for mount in binds)
    assert {mount["Source"] for mount in binds} == {str(BACKUP / (name + ".dump")) for name in EXPECTED}
    report["isolation"] = {"network": "none", "publishedPorts": False, "memoryBytes": host["Memory"], "memorySwapBytes": host["MemorySwap"], "cpus": .5, "pidLimit": host["PidsLimit"], "hostDataMounts": "exactly two read-only captured dump files", "freshNamedVolume": True}
    for attempt in range(90):
        ready = subprocess.run(["docker", "exec", CONTAINER, "pg_isready", "-U", "postgres"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if ready.returncode == 0:
            break
        time.sleep(.5)
    else:
        raise RuntimeError("Isolated database did not become ready")
    version = int(sql("postgres", "SELECT current_setting('server_version_num');", "server-version"))
    assert 160000 <= version < 170000, "Incompatible restore server version"
    report["postgresVersionNumber"] = version
    for database in EXPECTED:
        schema = command(["docker", "exec", CONTAINER, "pg_restore", "--schema-only", "--no-owner", "--no-privileges", "--file=-", "/restore/" + database + ".dump"], database + "-schema").decode()
        roles = set()
        for policy in re.finditer(r"CREATE POLICY [\s\S]+?;", schema):
            match = re.search(r"\bTO\s+(.+?)\s+(?:USING|WITH CHECK)\b", policy.group())
            if match:
                roles.update(value.strip().strip('"') for value in match.group(1).split(","))
        roles.discard("PUBLIC")
        for role in sorted(roles):
            assert re.fullmatch(r"[a-zA-Z_][a-zA-Z0-9_]{0,62}", role)
            if sql("postgres", "SELECT count(*) FROM pg_roles WHERE rolname='" + role + "';", database + "-role-check-" + role) == "0":
                sql("postgres", 'CREATE ROLE "' + role + '" NOLOGIN;', database + "-role-create-" + role)
        sql("postgres", 'CREATE DATABASE "' + database + '_restore";', database + "-create-db")
        counts = archived_counts(database)
        command(["docker", "exec", CONTAINER, "pg_restore", "--exit-on-error", "--no-owner", "--no-privileges", "-U", "postgres", "-d", database + "_restore", "/restore/" + database + ".dump"], database + "-restore")
        actual = {}
        for table, count in counts.items():
            assert re.fullmatch(r'[a-zA-Z0-9_".]+', table)
            actual[table] = int(sql(database + "_restore", "SELECT count(*) FROM " + table + ";", database + "-count-" + table))
            assert count == actual[table], "Restored count differs from archived count for " + table
        integrity = json.loads(sql(database + "_restore", "SELECT json_build_object('unvalidatedConstraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND NOT c.convalidated),'invalidIndexes',(SELECT count(*) FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND NOT i.indisvalid),'constraints',(SELECT count(*) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema')));", database + "-integrity"))
        assert integrity["unvalidatedConstraints"] == 0 and integrity["invalidIndexes"] == 0
        report["databases"][database].update({"restoreExitCode": 0, "policyNoLoginRoles": sorted(roles), "tableCount": len(actual), "tableRowCounts": actual, "archivedTableCountsMatch": True, "integrity": integrity})
        if database == "commerce_language":
            row = json.loads(sql(database + "_restore", "SELECT json_build_object('id',d.id,'fingerprint',d.fingerprint,'artifact',d.artifact,'archive',encode(d.corpus_gzip,'base64')) FROM release.channels c JOIN release.dictionaries d ON d.id=c.release_id WHERE c.channel='production';", "baseline-release-identity"))
            assert row["id"] == IDENTITY["releaseId"] and row["fingerprint"] == IDENTITY["fingerprint"]
            row["artifact"].pop("corpus", None)
            artifact_hash = digest(json.dumps(row["artifact"], sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode())
            assert artifact_hash == IDENTITY["artifactSha256"]
            corpus = gzip.decompress(base64.b64decode(row["archive"]))
            assert digest(corpus) == IDENTITY["corpusSha256"]
            report["baselineIdentity"] = {**IDENTITY, "artifactHashVerified": True, "corpusHashVerified": True, "corpusCases": len(corpus.splitlines())}
    report["status"] = "passed_same_host_production_backup_full_restore"
except Exception as caught:
    error = caught
    report["status"] = "restore_rehearsal_failed"
    report["error"] = str(caught)
finally:
    cleanup = []
    if created_container:
        result = subprocess.run(["docker", "rm", "-fv", CONTAINER], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        report["logHashes"]["remove-container"] = {"exitCode": result.returncode, "stdoutSha256": digest(result.stdout), "stderrSha256": digest(result.stderr)}
        if result.returncode:
            cleanup.append("container removal failed")
    if created_volume:
        result = subprocess.run(["docker", "volume", "rm", VOLUME], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        report["logHashes"]["remove-volume"] = {"exitCode": result.returncode, "stdoutSha256": digest(result.stdout), "stderrSha256": digest(result.stderr)}
        if result.returncode:
            cleanup.append("volume removal failed")
    report["containerRemoved"] = report["volumeRemoved"] = not cleanup
    report["cleanupErrors"] = cleanup
    if cleanup:
        report["status"] = "cleanup_failed"
        error = RuntimeError("; ".join(cleanup))
    report["backupFilesUnchanged"] = True
    report["completedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
print(json.dumps(report, sort_keys=True))
if error:
    raise SystemExit(1)
