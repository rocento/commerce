#!/usr/bin/env python3
"""Unprivileged health API. Authenticates through the existing grocery admin service."""
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request

WEB_ROOT = Path(os.environ.get(
    'HEALTH_WEB_ROOT',
    Path(__file__).resolve().parents[2] / 'commerce-web/apps/health',
))
STATE = Path(os.environ.get('HEALTH_STATE_DIR', '/var/lib/rocento-health'))
ORIGIN = 'https://health.rocento.com'
ACCOUNT = 'info@rocento.com'
COOKIE = '__Host-rocento_health'

def upstream(path, token='', body=None):
    headers = {'Host': 'grocery.rocento.com', 'X-Commerce-Request': '1'}
    if token:
        headers['Cookie'] = 'admin_session=' + token
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request('http://127.0.0.1:8080'+path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=8) as response:
            return response.status, json.loads(response.read(32768)), response.headers.get_all('Set-Cookie', [])
    except urllib.error.HTTPError as error:
        with error:
            return error.code, {}, []
    except (OSError, ValueError):
        return 503, {}, []

def allowed(identity):
    return identity.get('user', {}).get('email', '').lower() == ACCOUNT and identity.get('user', {}).get('active') is True

class Handler(BaseHTTPRequestHandler):
    server_version = 'RocentoHealth'
    sys_version = ''
    def setup(self):
        super().setup()
        self.connection.settimeout(12)
    def log_message(self, *args):
        pass  # Never log cookies, passwords, or request bodies.
    def send(self, status, body, content_type='application/json', cookie=None):
        if content_type == 'application/json':
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        self.wfile.write(body)
    def token(self):
        try:
            jar = SimpleCookie(self.headers.get('Cookie', ''))
            token = jar[COOKIE].value if COOKIE in jar else ''
            return token if len(token) < 512 and all(c.isalnum() or c in '-_' for c in token) else ''
        except Exception:
            return ''
    def authenticate(self):
        token = self.token()
        if not token:
            return False, 401
        status, identity, _ = upstream('/v1/admin/me', token)
        return status == 200 and allowed(identity), (503 if status >= 500 else 401)
    def do_GET(self):
        assets = {'/': ('index.html', 'text/html; charset=utf-8'), '/app.js': ('app.js', 'text/javascript; charset=utf-8'), '/style.css': ('style.css', 'text/css; charset=utf-8')}
        if self.path in assets:
            name, mime = assets[self.path]
            return self.send(200, (WEB_ROOT/name).read_bytes(), mime)
        if self.path not in ('/api/session', '/api/health'):
            return self.send(404, {'error': 'Not found'})
        ok, status = self.authenticate()
        if not ok:
            return self.send(status, {'error': 'Sign in required' if status == 401 else 'Authentication service unavailable'})
        if self.path == '/api/session':
            return self.send(200, {'email': ACCOUNT})
        try:
            data = json.loads((STATE/'snapshot.json').read_text())
            data['stale'] = time.time()-data['checked_at'] > 180
            if data['stale']:
                data['status'] = 'unknown'
            return self.send(200, data)
        except (OSError, ValueError):
            return self.send(503, {'error': 'Health collector has not produced a snapshot'})
    def do_POST(self):
        if self.headers.get('Origin') != ORIGIN or self.headers.get('Content-Type', '').split(';')[0] != 'application/json':
            return self.send(403, {'error': 'Request rejected'})
        if self.path == '/api/logout':
            status, _, _ = upstream('/v1/admin/auth/logout', self.token(), {})
            return self.send(200 if status < 500 else 503, {'ok': status < 500}, cookie=f'{COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0')
        if self.path != '/api/login':
            return self.send(404, {'error': 'Not found'})
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 < length <= 4096:
                raise ValueError()
            body = json.loads(self.rfile.read(length))
            if not isinstance(body, dict) or not isinstance(body.get('password'), str) or body.get('email', '').strip().lower() != ACCOUNT:
                return self.send(401, {'error': 'Invalid credentials'})
        except (ValueError, TypeError, AttributeError):
            return self.send(400, {'error': 'Invalid request'})
        status, identity, cookies = upstream('/v1/admin/auth/login', body={'email': ACCOUNT, 'password': body['password']})
        if status != 200 or not allowed(identity):
            return self.send(429 if status == 429 else 503 if status >= 500 else 401, {'error': 'Too many attempts; try again later' if status == 429 else 'Authentication service unavailable' if status >= 500 else 'Invalid credentials'})
        for value in cookies:
            jar = SimpleCookie(value)
            if 'admin_session' in jar:
                token = jar['admin_session'].value
                return self.send(200, {'email': ACCOUNT}, cookie=f'{COOKIE}={token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800')
        self.send(503, {'error': 'Authentication service unavailable'})

if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', 8099), Handler).serve_forever()
