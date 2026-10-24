#!/usr/bin/env python3
"""Bounded macOS simulator worker; private loopback API reached through SSH.

Only operator-provisioned signed Studio artifacts can run. No client paths,
commands, native code, URLs or simulator identifiers are accepted.
"""
import argparse
import datetime as dt
import hmac
import fcntl
import json
import os
from pathlib import Path
import plistlib
import re
import signal
import socket
import struct
from interactive import Interactive, validate_input
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_FRAME = 8 * 1024 * 1024


def run(*args, env=None, timeout=120):
    # Never include subprocess output/arguments (may contain capabilities) in errors.
    result = subprocess.run(args, env=env, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError('simulator operation failed')
    return result.stdout


def validate_request(session, data, artifacts):
    if not isinstance(data, dict) or not all(isinstance(v, str) for v in data.values()):
        raise ValueError('invalid body')
    required = {'merchantId', 'environment', 'code', 'expiresAt'}
    if str(uuid.UUID(session)) != session or not required <= set(data) or set(data) - required - {'implementation'}:
        raise ValueError('invalid session')
    implementation = data.get('implementation', 'native')
    if implementation not in ('native', 'react-native'):
        raise ValueError('invalid implementation')
    key = f"{data['merchantId']}:{data['environment']}"
    if implementation == 'react-native':
        key += ':react-native'
    if key not in artifacts or not re.fullmatch(re.escape(session) + r'\.[a-f0-9]{64}', data['code']):
        raise ValueError('unsupported artifact or capability')
    expiry = dt.datetime.fromisoformat(data['expiresAt'].replace('Z', '+00:00')).timestamp()
    if not time.time() < expiry <= time.time() + 1801:
        raise ValueError('invalid expiry')
    return artifacts[key], expiry


class Worker:
    def __init__(self, args):
        self.args = args
        self.root = Path(args.state).resolve()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        self.process_lock = (self.root / 'worker.lock').open('w')
        fcntl.flock(self.process_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Separate CoreSimulator device set: cleanup cannot touch personal devices.
        self.devices = self.root / 'devices'
        self.devices.mkdir(exist_ok=True)
        self.lock = threading.RLock()
        self.sessions = {}
        self.threads = []
        self.artifacts = json.loads(Path(args.artifacts).read_text())
        for key, artifact in self.artifacts.items():
            info = plistlib.loads((Path(artifact['app']) / 'Info.plist').read_bytes())
            tenant, environment = key.split(':')
            actual_env = 'production' if info.get('RocentoProduction') == 'YES' else 'staging'
            if info.get('RocentoTenant') != tenant or actual_env != environment or info.get('CFBundleIdentifier') != artifact['bundleId']:
                raise ValueError('artifact identity does not match allowlist')
            run('python3', args.signing_check, artifact['app'], '--platform', 'simulator',
                '--bundle-id', artifact['bundleId'], '--baseline-app', artifact['app'])
        # Recover worker-owned devices after a crash; never rehydrate bearer tokens.
        devices = json.loads(self.sim('list', 'devices', '--json'))['devices']
        for group in devices.values():
            for device in group:
                if device['name'].startswith('RocentoWorker-'):
                    self.destroy(device['udid'])
        threading.Thread(target=self.reap, daemon=True).start()

    def sim(self, *args, **kwargs):
        return run('xcrun', 'simctl', '--set', str(self.devices), *args, **kwargs)

    def destroy(self, device):
        try:
            self.sim('shutdown', device, timeout=30)
        except Exception:
            pass
        self.sim('delete', device, timeout=30)

    def start(self, sid, data):
        artifact, expiry = validate_request(sid, data, self.artifacts)
        with self.lock:
            if sid in self.sessions:
                raise ValueError('session already exists')
            if len(self.sessions) >= self.args.capacity:
                return False
            state = {'expiry': expiry, 'lease': time.monotonic() + 180,
                     'stop': threading.Event(), 'frame': None, 'captured': 0, 'failed': False, 'finished': False, 'interactive': None, 'video': None, 'video_number': 0, 'viewers': 0}
            self.sessions[sid] = state
        thread = threading.Thread(target=self.simulate, args=(sid, state, artifact, data['code']), daemon=True)
        with self.lock:
            self.threads = [t for t in self.threads if t.is_alive()]
            self.threads.append(thread)
        thread.start()
        return True

    def simulate(self, sid, state, artifact, code):
        device = None
        interactive = None
        frame = self.root / f'{sid}.png'
        phase = 'create'
        try:
            device = self.sim('create', 'RocentoWorker-' + sid, self.args.device, self.args.runtime).decode().strip()
            phase = 'boot'
            self.sim('boot', device)
            self.sim('bootstatus', device, '-b', timeout=180)
            phase = 'certificate'
            if self.args.trust_cert:
                self.sim('keychain', device, 'add-root-cert', self.args.trust_cert)
            if state['stop'].is_set():
                return
            phase = 'signing'
            run('python3', self.args.signing_check, artifact['app'], '--platform', 'simulator',
                '--bundle-id', artifact['bundleId'], '--simulator', device, '--simulator-set', str(self.devices))
            phase = 'install'
            self.sim('install', device, artifact['app'])
            phase = 'launch'
            env = dict(os.environ, SIMCTL_CHILD_ROCENTO_PREVIEW_CODE=code)
            self.sim('launch', device, artifact['bundleId'], '-rocento-draft-preview', env=env)
            del env, code
            def publish(payload):
                with self.lock:
                    state['video'] = payload
                    state['video_number'] += 1
                    state['captured'] = time.monotonic()
            phase = 'capture'
            interactive = Interactive(device, self.devices, self.root, state['stop'], publish, fps=self.args.fps)
            with self.lock:
                state['interactive'] = interactive
            interactive.run()
        except Exception as error:
            print(f'Preview worker failed during {phase}: {type(error).__name__}', flush=True)
            with self.lock:
                state['failed'] = True
                state['frame'] = None
        finally:
            if interactive:
                interactive.close()
            frame.unlink(missing_ok=True)
            cleanup_failed = False
            if device:
                try:
                    self.destroy(device)
                except Exception:
                    # Quarantine this slot until restart recovery succeeds.
                    with self.lock:
                        state['failed'] = True
                    cleanup_failed = True
            with self.lock:
                state['finished'] = not cleanup_failed
                if state['stop'].is_set() and not cleanup_failed:
                    self.sessions.pop(sid, None)

    def get(self, sid):
        with self.lock:
            state = self.sessions.get(sid)
            if not state or state['stop'].is_set() or time.time() >= state['expiry']:
                return 404, b''
            if state['failed']:
                return 503, b''
            state['lease'] = time.monotonic() + 45
            payload = state.get('video') or state['frame']
            if payload is None:
                return 202, b''
            if time.monotonic() - state['captured'] > 15:
                return 503, b''
            return 200, payload

    def input(self, sid, data):
        validate_input(data)
        with self.lock:
            state = self.sessions.get(sid)
            if not state or state['stop'].is_set() or time.time() >= state['expiry']:
                return 404
            if not state['interactive'] or time.monotonic() - state['captured'] > 3:
                return 503
            adapter = state['interactive']
        return adapter.input(data)

    def video(self, sid, output):
        with self.lock:
            state = self.sessions.get(sid)
            if not state or state['stop'].is_set() or time.time() >= state['expiry']: return 404
            if state['failed'] or (state['video'] and time.monotonic() - state['captured'] > 3): return 503
            if state['viewers'] >= 2: return 409
            state['viewers'] += 1
        try:
            # Keep slow viewers from accumulating seconds of historical video in
            # the kernel. A stalled connection can reconnect to the newest frame.
            output.connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 64 * 1024)
            output.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            output.connection.settimeout(2)
            output.send_response(200)
            output.send_header('Content-Type', 'application/x-rocento-mjpeg')
            output.send_header('Cache-Control', 'private, no-store')
            output.send_header('X-Accel-Buffering', 'no')
            output.end_headers()
            last = -1
            heartbeat = time.monotonic()
            while not state['stop'].is_set() and time.time() < state['expiry']:
                with self.lock:
                    state['lease'] = time.monotonic() + 45
                    number, payload = state['video_number'], state['video']
                    failed = state['failed'] or (payload and time.monotonic() - state['captured'] > 3)
                if failed: break
                if payload and number != last:
                    output.wfile.write(struct.pack('<I', len(payload)) + payload)
                    output.wfile.flush()
                    last = number
                elif time.monotonic() - heartbeat >= 1:
                    output.wfile.write(b'\0\0\0\0'); output.wfile.flush()
                    heartbeat = time.monotonic()
                state['stop'].wait(1 / 60)
        except (TimeoutError, BrokenPipeError, ConnectionResetError):
            pass
        finally:
            with self.lock: state['viewers'] -= 1
        return None

    def stop(self, sid):
        with self.lock:
            if sid in self.sessions:
                self.sessions[sid]['stop'].set()

    def reap(self):
        while True:
            time.sleep(2)
            with self.lock:
                for sid, state in list(self.sessions.items()):
                    if time.time() >= state['expiry'] or time.monotonic() >= state['lease']:
                        state['stop'].set()
                    if state['stop'].is_set() and state['finished']:
                        self.sessions.pop(sid, None)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def handle_request(self):
        self.connection.settimeout(10)
        expected = 'Bearer ' + self.server.token
        if not hmac.compare_digest(self.headers.get('Authorization', '').encode(), expected.encode()):
            self.reply(401)
            return
        if self.path == '/health' and self.command == 'GET':
            with self.server.worker.lock:
                # Count devices being cleaned up too; EC2 stop must not interrupt cleanup.
                active = sum(not state['finished'] for state in self.server.worker.sessions.values())
            body = json.dumps({'ready': True, 'activeSessions': active}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(body)
            return
        match = re.fullmatch(r'/sessions/([a-f0-9-]{36})(/video|/input)?', self.path)
        if not match:
            self.reply(404)
            return
        sid = match[1]
        try:
            if self.command == 'GET' and match[2] == '/video':
                status = self.server.worker.video(sid, self)
                if status: self.reply(status)
                return
            if match[2] and not (self.command == 'POST' and match[2] == '/input'):
                self.reply(404); return
            if self.command == 'POST':
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 2048:
                    raise ValueError('invalid body length')
                data = json.loads(self.rfile.read(size))
                self.reply(self.server.worker.input(sid, data) if match[2] == '/input' else (202 if self.server.worker.start(sid, data) else 409))
            elif self.command == 'DELETE':
                self.server.worker.stop(sid)
                self.reply(204)
            else:
                status, body = self.server.worker.get(sid)
                self.reply(status, body)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        except RuntimeError:
            self.reply(503)
        except (ValueError, KeyError, TypeError, OverflowError):
            self.reply(400)

    def reply(self, status, body=b''):
        self.send_response(status)
        self.send_header('Content-Type', ('image/jpeg' if body.startswith(b'\xff\xd8') else 'image/png') if body else 'application/octet-stream')
        self.send_header('Cache-Control', 'private, no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = do_DELETE = handle_request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--artifacts', required=True)
    parser.add_argument('--state', required=True)
    parser.add_argument('--signing-check', required=True)
    parser.add_argument('--runtime', required=True)
    parser.add_argument('--device', default='com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro')
    parser.add_argument('--capacity', type=int, default=1)
    parser.add_argument('--fps', type=int, choices=range(1, 61), metavar='1..60', default=30,
                        help='Capture target (1..60); delivered FPS depends on host and transport')
    parser.add_argument('--port', type=int, default=19095)
    parser.add_argument('--trust-cert', help='Development only: local API root certificate')
    args = parser.parse_args()
    token = os.environ.get('MOBILE_PREVIEW_WORKER_TOKEN', '')
    if len(token) < 32 or not 1 <= args.capacity <= 8:
        parser.error('Require a >=32-character worker token and capacity 1..8')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.token = token
    server.worker = Worker(args)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    try:
        server.serve_forever()
    finally:
        server.server_close()
        for sid in list(server.worker.sessions):
            server.worker.stop(sid)
        for thread in server.worker.threads:
            thread.join(timeout=240)


if __name__ == '__main__':
    main()
