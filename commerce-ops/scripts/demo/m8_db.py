"""Local-only Docker helpers, with credentials kept inside containers."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
def pg(sql):
    return subprocess.check_output(['docker','compose','-f',str(ROOT/'commerce-ops/compose/compose.yaml'),'exec','-T','postgres','sh','-c','exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At','sh'],input=sql,cwd=ROOT,text=True).strip()
def ch(sql,body=''):
    return subprocess.check_output(['docker','compose','-f',str(ROOT/'commerce-ops/compose/compose.yaml'),'exec','-T','clickhouse','sh','-c','exec clickhouse-client --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database commerce_analytics --query "$1"','sh',sql],input=body,cwd=ROOT,text=True).strip()
