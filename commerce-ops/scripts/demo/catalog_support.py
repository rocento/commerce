"""Shared local demo client. Uses the existing private admin credential file."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import http.cookiejar
import json
from pathlib import Path
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[3]
BASE = 'http://localhost:5174/api'

class Client:
    def __init__(self):
        self.http = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        credentials = dict(line.split(': ', 1) for line in (ROOT / '.local/admin-credentials.txt').read_text().splitlines() if ': ' in line)
        self.call('POST', '/v1/admin/auth/login', {'email': credentials['Email'], 'password': credentials['Password']})

    def call(self, method, path, body=None):
        request = urllib.request.Request(BASE + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={'Content-Type': 'application/json', 'X-Commerce-Request': '1'})
        with self.http.open(request, timeout=20) as response:
            return json.load(response)

    def upload(self, image, alt):
        boundary = 'commerce-' + uuid.uuid4().hex
        data = (f'--{boundary}\r\nContent-Disposition: form-data; name="alt"\r\n\r\n{alt}\r\n'
                f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="product.png"\r\nContent-Type: image/png\r\n\r\n').encode() + image + f'\r\n--{boundary}--\r\n'.encode()
        request = urllib.request.Request(BASE + '/v1/admin/catalog/media', data=data,
            headers={'Content-Type': 'multipart/form-data; boundary=' + boundary, 'X-Commerce-Request': '1'})
        with self.http.open(request, timeout=30) as response:
            return json.load(response)
