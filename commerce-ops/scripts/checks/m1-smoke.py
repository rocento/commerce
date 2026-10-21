"""Local-only HTTP check: signup -> delivered verification -> login -> location -> logout.

Creates a uniquely named synthetic customer in the local development database. The notification
adapter only logs messages; no external email or SMS is sent. Prints no credentials or tokens.
"""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import http.cookiejar
import json
import subprocess
import urllib.error
import urllib.request
import uuid

identity = f'm1-smoke-{uuid.uuid4().hex[:10]}@example.test'
password = uuid.uuid4().hex
jar = http.cookiejar.CookieJar()
http = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))

def request(method, path, body=None, token=None):
    headers = {'Content-Type': 'application/json', 'X-Commerce-Request': '1'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    req = urllib.request.Request('http://localhost:5173/api/v1/customer' + path,
                                 data=json.dumps(body).encode() if method != 'GET' else None,
                                 headers=headers, method=method)
    with http.open(req, timeout=15) as response:
        return json.load(response)

created = request('POST', '/auth/register', {'identifier': identity, 'password': password})
assert not created['verified']
logs = subprocess.check_output(['docker', 'compose', '-f', str(ROOT / 'commerce-ops/compose/compose.yaml'), 'logs', '--no-log-prefix', 'api-gateway'], text=True)
notifications = []
for line in logs.splitlines():
    try:
        row = json.loads(line)
    except json.JSONDecodeError:
        continue
    if row.get('target') == 'local_notifications' and row.get('fields', {}).get('identifier') == identity:
        notifications.append(row['fields'])
assert notifications, 'Local notification was not delivered'
request('POST', '/auth/verify', {'identifier': identity, 'token': notifications[-1]['code']})
auth = request('POST', '/auth/login', {'identifier': identity, 'password': password})
assert auth['customer']['verified']
location = request('POST', '/locations', {'label': 'home', 'latitude': 30, 'longitude': 31,
                                        'formatted_address': 'Synthetic test location'}, auth['access_token'])
assert location['is_default']
assert len(request('GET', '/locations', token=auth['access_token'])) == 1
refreshed = request('POST', '/auth/refresh')
assert request('GET', '/me', token=refreshed['access_token'])['id'] == created['id']
request('POST', '/auth/logout', token=refreshed['access_token'])
try:
    request('GET', '/me', token=refreshed['access_token'])
    raise AssertionError('Logged-out session remained valid')
except urllib.error.HTTPError as error:
    assert error.code == 401
print('PASS M1 live signup, console notification, verification, login, saved location, refresh and logout')
