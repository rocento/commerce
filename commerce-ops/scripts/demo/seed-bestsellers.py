"""Add repeat-safe dummy completed sales for last calendar month (UTC).

Explicitly choose --local or --store grocery|jewelry|electronics for deployed demos.
These synthetic orders appear in sales reports. Normal deployment never runs this.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser(description=__doc__)
target = parser.add_mutually_exclusive_group(required=True)
target.add_argument('--local', action='store_true')
target.add_argument('--store', choices=['grocery', 'jewelry', 'electronics'])
args = parser.parse_args()
sql = (root / 'commerce-assets/demo/seed-bestsellers.sql').read_text()
psql = 'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'
if args.local:
    command = ['docker', 'compose', '-f', str(root / 'commerce-ops/compose/compose.yaml'), 'exec', '-T', 'postgres', 'sh', '-c', psql]
else:
    import shlex
    remote = ['sudo', '-n', 'bash', '/opt/rocento/deploy/ec2/server/ec2-compose.sh', args.store,
              'exec', '-T', 'postgres', 'sh', '-c', psql]
    command = ['ssh', '-i', str(root / 'commerce-ops/deploy/aws-deploy/rocento.pem'), '-o', 'BatchMode=yes',
               '-o', 'ConnectTimeout=20', 'ubuntu@3.78.102.161', shlex.join(remote)]
subprocess.run(command, input=sql, text=True, cwd=root, check=True)
