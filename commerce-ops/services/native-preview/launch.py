#!/usr/bin/env python3
"""Run an unpacked worker deployment; secrets remain in a private operator file."""
import json
import os
from pathlib import Path
import sys

root = Path(__file__).resolve().parent
state = Path(os.environ['MOBILE_PREVIEW_STATE']).resolve()
state.mkdir(parents=True, exist_ok=True, mode=0o700)
token_path = Path(os.environ['MOBILE_PREVIEW_WORKER_TOKEN_FILE'])
if token_path.stat().st_mode & 0o077:
    raise ValueError('Worker token file must be owner-only')
os.environ['MOBILE_PREVIEW_WORKER_TOKEN'] = token_path.read_text().strip()
manifest = json.loads((root/'artifacts.json').read_text())
for artifact in manifest.values():
    artifact['app'] = str(root/artifact['app'])
path = state/'artifacts.json'
path.write_text(json.dumps(manifest))
os.execv(sys.executable, [sys.executable, str(root/'worker.py'), '--artifacts', str(path),
    '--state', str(state), '--signing-check', str(root/'check_ios_signing.py'),
    '--runtime', os.environ['MOBILE_PREVIEW_RUNTIME'],
    '--capacity', os.environ.get('MOBILE_PREVIEW_CAPACITY', '1'),
    '--fps', os.environ.get('MOBILE_PREVIEW_FPS', '30')])
