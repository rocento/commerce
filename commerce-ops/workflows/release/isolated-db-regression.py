"""Database settings and checkout regression tests on an isolated Postgres instance."""

import os
import subprocess
from reliability_support import ROOT, Stack

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
