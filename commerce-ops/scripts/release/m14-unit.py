"""Database settings and checkout regression tests on an isolated Postgres instance."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import os
import subprocess
from m14_support import ROOT, Stack

stack = Stack()
stack.spec['services'] = {'postgres': stack.spec['services']['postgres']}
stack.spec['volumes'] = {'postgres-data': {}}
try:
    stack.save()
    stack.compose('up', '-d', '--wait', '--wait-timeout', '90')
    env = dict(os.environ, DATABASE_URL=stack.database_url())
    for args in [
        ['-p', 'infra-db', '--lib'],
        ['-p', 'api-gateway', '--test', 'orders', '--test', 'cart_inventory'],
    ]:
        subprocess.run(['cargo', 'test', '--manifest-path', str(ROOT / 'commerce-api/rocento-api/Cargo.toml'),
                        '--offline', *args], env=env, check=True)
finally:
    stack.close()
