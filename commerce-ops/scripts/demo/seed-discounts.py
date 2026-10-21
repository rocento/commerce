"""Install repeat-safe, 30-day discount rules on five existing grocery demo products."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import shlex
import subprocess
from pathlib import Path


def main():
    root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description=__doc__)
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--local", action="store_true")
    target.add_argument("--store", choices=["grocery"])
    args = parser.parse_args()
    sql = (root / "commerce-assets/demo/seed-discounts.sql").read_text()
    psql = 'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At'
    if args.local:
        command = ["docker", "compose", "-f", str(root / "commerce-ops/compose/compose.yaml"), "exec", "-T", "postgres", "sh", "-c", psql]
    else:
        remote = ["sudo", "-n", "bash", "/opt/rocento/deploy/ec2/server/ec2-compose.sh", args.store,
                  "exec", "-T", "postgres", "sh", "-c", psql]
        command = ["ssh", "-i", str(root / "commerce-ops/deploy/aws-deploy/rocento.pem"), "-o", "BatchMode=yes",
                   "-o", "ConnectTimeout=20", "ubuntu@3.78.102.161", shlex.join(remote)]
    subprocess.run(command, input=sql, text=True, cwd=root, check=True)


if __name__ == "__main__":
    main()
