"""Operator migration/provisioning for the existing local AI store; never run by chat."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import os
import secrets
import subprocess
from pathlib import Path

root = Path(__file__).resolve().parents[3]
key = root / '.local/assistant/knowledge-writer-password'
key.parent.mkdir(parents=True, exist_ok=True)
if not key.exists():
    fd = os.open(key, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(secrets.token_urlsafe(48))
password = key.read_text().strip()
# Only accept our generated token form, so the secret never becomes SQL syntax.
if not password or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in password):
    raise SystemExit('Invalid writer password file')
sql = (root / 'commerce-assistant-platform/migrations/003_knowledge.sql').read_text()
sql += "\nALTER ROLE ai_knowledge_writer LOGIN PASSWORD '" + password + "';\n"
subprocess.run(['docker', 'exec', '-i', 'commerce-ai-ai-postgres-1', 'psql',
    '-U', 'ai_owner', '-d', 'assistant', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True, check=True,
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
print('AI knowledge migration applied; separate operator credential saved in .local/assistant/knowledge-writer-password')
