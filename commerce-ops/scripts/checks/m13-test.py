"""Run M13 plus inventory/checkout regressions using SQLx disposable databases."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

from pathlib import Path
import os
import subprocess
from urllib.parse import quote
root=Path(__file__).resolve().parents[3]
values=dict(line.split('=',1) for line in (root/'.env').read_text().splitlines() if '=' in line and not line.startswith('#'))
env=os.environ.copy()
env['DATABASE_URL']='postgres://{}:{}@127.0.0.1:5432/{}'.format(quote(values.get('POSTGRES_USER','commerce'),safe=''),quote(values['POSTGRES_PASSWORD'],safe=''),quote(values.get('POSTGRES_DB','commerce'),safe=''))
subprocess.run(['cargo','test','-p','api-gateway','--test','delivery_areas','--test','cart_inventory','--test','orders'],cwd=root/'commerce-api',env=env,check=True)
