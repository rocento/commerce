"""Generate independent local assistant keys; never replace an existing private key."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import os
import subprocess
from pathlib import Path
root = Path(__file__).resolve().parents[3] / '.local' / 'assistant'
root.mkdir(parents=True, exist_ok=True)
root.chmod(0o700)
private = root / 'private.pem'
public = root / 'public.pem'
if not private.exists():
    subprocess.run(['openssl','genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:3072','-out',str(private)],check=True,stderr=subprocess.DEVNULL)
    os.chmod(private,0o644)
# Parent directory is 0700; only the gateway receives this read-only bind mount.
os.chmod(private,0o644)
if not public.exists():
    subprocess.run(['openssl','pkey','-in',str(private),'-pubout','-out',str(public)],check=True)
    os.chmod(public,0o644)
print('Local assistant keys ready. Keep .local private; never use test fixture keys for deployment.')

import secrets
for name in ('store-admin-password','store-runtime-password'):
    path=root/name
    if not path.exists():
        path.write_text(secrets.token_urlsafe(48))
        # Read-only bind mounts must be readable by the non-root service UID locally.
        # The containing .local directory is private to the workstation user.
        path.chmod(0o644)
