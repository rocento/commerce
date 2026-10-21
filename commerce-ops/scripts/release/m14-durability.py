"""Isolated Postgres durability drill using the application's resolved Compose service.

Runs restart/recreation, crash rollback and logical backup checks on synthetic data.
Never targets the development database. Test volume is retained for inspection;
its exact name and a manual cleanup command are printed (no automatic volume deletion).
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import json
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]


def run(args, **kwargs):
    return subprocess.run(args, check=True, capture_output=True, **kwargs).stdout


def main():
    project = 'commerce-m14-' + uuid.uuid4().hex[:12]
    config = json.loads(run(['docker', 'compose', '-f', str(ROOT / 'commerce-ops/compose/compose.yaml'), 'config', '--format', 'json'], cwd=ROOT))
    postgres = config['services']['postgres']
    postgres.pop('ports', None)
    postgres.pop('container_name', None)
    postgres.pop('networks', None)
    postgres['restart'] = 'no'
    postgres['volumes'] = [{'type': 'volume', 'source': 'data', 'target': '/var/lib/postgresql/data'}]
    with tempfile.TemporaryDirectory(prefix='commerce-m14-') as directory:
        path = Path(directory) / 'compose.json'
        path.write_text(json.dumps({'services': {'postgres': postgres}, 'volumes': {'data': {}}}))
        path.chmod(0o600)
        base = ['docker', 'compose', '-p', project, '-f', str(path)]

        def compose(*args):
            return run(base + list(args))

        def sql(query):
            return compose('exec', '-T', 'postgres', 'sh', '-c',
                           'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "$1"',
                           'sh', query).decode().strip()

        def intact():
            assert sql('SELECT payload FROM durability_probe WHERE id=1') == 'acknowledged'
            assert sql('SELECT count(*) FROM durability_probe') == '1'

        try:
            compose('up', '-d', '--wait', '--wait-timeout', '120')
            assert sql('SHOW fsync') == 'on'
            assert sql('SHOW synchronous_commit') == 'on'
            assert sql('SHOW full_page_writes') == 'on'
            assert sql('SHOW wal_level') in ('replica', 'logical')
            sql('CREATE TABLE durability_probe(id integer PRIMARY KEY, payload text NOT NULL)')
            sql("INSERT INTO durability_probe VALUES (1, 'acknowledged')")
            compose('restart', 'postgres')
            compose('up', '-d', '--wait', '--wait-timeout', '120')
            intact()
            print('PASS DUR-01: acknowledged row survived restart', flush=True)
            compose('down')
            compose('up', '-d', '--wait', '--wait-timeout', '120')
            intact()
            print('PASS DUR-03: acknowledged row survived container recreation', flush=True)
            transaction = subprocess.Popen(base + ['exec', '-T', 'postgres', 'sh', '-c',
                'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"', 'sh',
                "SET application_name='m14_crash_probe'; BEGIN; INSERT INTO durability_probe VALUES (2,'uncommitted'); SELECT pg_sleep(60); COMMIT;"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 15
                while sql("SELECT count(*) FROM pg_stat_activity WHERE application_name='m14_crash_probe' AND wait_event='PgSleep'") != '1':
                    if time.monotonic() > deadline:
                        raise RuntimeError('Transaction did not reach crash barrier')
                    time.sleep(.1)
                compose('kill', '-s', 'SIGKILL', 'postgres')
                transaction.wait(timeout=15)
            finally:
                if transaction.poll() is None:
                    transaction.terminate()
                    transaction.wait(timeout=15)
            compose('up', '-d', '--wait', '--wait-timeout', '120')
            intact()
            print('PASS storage crash: uncommitted write rolled back; acknowledged row retained (not checkout DUR-02)', flush=True)
            backup = compose('exec', '-T', 'postgres', 'sh', '-c',
                             'exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"')
            sql('CREATE DATABASE durability_restore')
            run(base + ['exec', '-T', 'postgres', 'sh', '-c',
                        'exec pg_restore --exit-on-error -U "$POSTGRES_USER" -d durability_restore'], input=backup)
            restored = compose('exec', '-T', 'postgres', 'sh', '-c',
                               'exec psql -U "$POSTGRES_USER" -d durability_restore -Atc "SELECT payload FROM durability_probe WHERE id=1"')
            assert restored.decode().strip() == 'acknowledged'
            print('PASS logical restore of synthetic database (not full DUR-08)', flush=True)
        finally:
            compose('down')
            print(f'Retained test volume: {project}_data')
            print(f'After inspection, explicitly confirm deletion with: docker volume rm {project}_data')


if __name__ == '__main__':
    main()
