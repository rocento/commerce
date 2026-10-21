"""Verify local HTTP readiness and frontend proxies; optionally check private AI."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import json
from pathlib import Path
import subprocess
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--assistant', action='store_true', help='Check the private Compose assistant readiness endpoint')
args = parser.parse_args()

for port, path in [(8080, '/health'), (8080, '/ready'), (5173, '/health'),
                   (5174, '/health'), (5173, '/api/health'), (5174, '/api/health')]:
    url = f'http://127.0.0.1:{port}{path}'
    with urllib.request.urlopen(url, timeout=10) as response:
        assert response.status == 200, url
        payload = json.load(response)
        assert payload['status'] == ('ready' if path == '/ready' else 'ok'), (url, payload)
    print(f'PASS {url}')

if args.assistant:
    root = Path(__file__).resolve().parents[3]
    probe = "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/ready', timeout=10).read().decode())"
    payload = json.loads(subprocess.check_output(
        ['bash', str(root / 'commerce-ops/scripts/local/local-compose.sh'), '--assistant', 'exec', '-T',
         'ai-service', 'python', '-c', probe], text=True, timeout=30))
    assert payload['status'] == 'ready', payload
    assert payload['components']['language'] == 'ready', payload
    assert payload['components']['storage'] == 'ready', payload
    print('PASS private assistant readiness (language + storage)')
