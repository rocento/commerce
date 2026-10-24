"""Local PostgreSQL and ClickHouse clients for demo and smoke fixtures."""

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
COMPOSE = ROOT / 'commerce-ops/compose/base/compose.yaml'


def pg(sql: str) -> str:
    return subprocess.check_output(
        [
            'docker', 'compose', '--project-directory', str(COMPOSE.parent.parent), '-f', str(COMPOSE), 'exec', '-T', 'postgres',
            'sh', '-c',
            'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At',
            'sh',
        ],
        input=sql, cwd=ROOT, text=True,
    ).strip()


def ch(sql: str, body: str = '') -> str:
    return subprocess.check_output(
        [
            'docker', 'compose', '--project-directory', str(COMPOSE.parent.parent), '-f', str(COMPOSE), 'exec', '-T', 'clickhouse',
            'sh', '-c',
            'exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" '
            '--database commerce_analytics --query "$1"',
            'sh', sql,
        ],
        input=body, cwd=ROOT, text=True,
    ).strip()
