"""Bootstrap the first local administrator. Never overwrites an existing account."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import os
from pathlib import Path
import secrets
import subprocess
import sys

root = Path(__file__).resolve().parents[3]
email = sys.argv[1] if len(sys.argv) > 1 else 'admin@demo.local'
folder = root / '.local'
folder.mkdir(mode=0o700, exist_ok=True)
target = folder / 'admin-credentials.txt'
if target.exists():
    raise SystemExit(f'Credentials already exist at {target}; no account was changed.')
password = secrets.token_urlsafe(24)
env = {**os.environ, 'BOOTSTRAP_ADMIN_PASSWORD': password}
subprocess.run(['docker', 'compose', '-f', str(root / 'commerce-ops/compose/compose.yaml'), 'exec', '-T', '-e', 'BOOTSTRAP_ADMIN_PASSWORD',
                'api-gateway', 'seed-admin', '--email', email], cwd=root, env=env, check=True)
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as handle:
    handle.write(f'Local development admin only\nURL: http://localhost:5174\nEmail: {email}\nPassword: {password}\n')
print(f'Local administrator created. Credentials saved privately in {target}')
