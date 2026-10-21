#!/usr/bin/env python3
"""Loopback-only EC2 lifecycle controller and authenticated Android worker proxy.
AWS credentials come from the demo host's instance role; no browser credentials.
"""
import hmac
import http.client
import json
import os
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Control:
    def __init__(self, ec2, instance, token, worker_port=19096):
        self.ec2, self.instance, self.token, self.worker_port = ec2, instance, token, worker_port
        self.lock = threading.RLock()
        self.stopping = False
        self.idle_since = None

    def check_idle(self):
        """Require five continuously observed idle minutes; serialize with session creation."""
        with self.lock:
            try:
                state = self.state()
                if state == "stopped": self.stopping = False
                if state != "running" or self.stopping or self.worker()["activeSessions"] != 0:
                    self.idle_since = None
                    return
                now = time.monotonic()
                if self.idle_since is None:
                    self.idle_since = now
                elif now - self.idle_since >= 300:
                    code, _ = self.action("stop")  # Recheck worker immediately before AWS stop.
                    self.idle_since = None
                    if code == 200:
                        print("Android EC2 auto-stop: five minutes without active previews", flush=True)
            except Exception:
                self.idle_since = None  # Unknown health is never evidence of idle time.
                raise

    def monitor_idle(self, shutdown):
        while not shutdown.is_set():
            try: self.check_idle()
            except Exception as error:
                print("Idle check unavailable: " + type(error).__name__, flush=True)
            shutdown.wait(10)

    def state(self):
        data = self.ec2.describe_instances(InstanceIds=[self.instance])
        return data['Reservations'][0]['Instances'][0]['State']['Name']

    def worker(self):
        connection = http.client.HTTPConnection('127.0.0.1', self.worker_port, timeout=3)
        try:
            connection.request('GET', '/health', headers={'Authorization': 'Bearer ' + self.token})
            response = connection.getresponse()
            if response.status != 200: raise RuntimeError('worker unavailable')
            data = json.loads(response.read(4096))
            if data.get('ready') is not True or type(data.get('activeSessions')) is not int:
                raise RuntimeError('invalid worker health')
            return data
        finally:
            connection.close()

    def status(self):
        state = self.state()
        if state == 'stopped': self.stopping = False
        result = {'state': state, 'ready': False, 'activeSessions': None}
        if state == 'running' and not self.stopping:
            try: result.update(self.worker())
            except (OSError, ValueError, RuntimeError, http.client.HTTPException): pass
        return result

    def action(self, action):
        with self.lock:
            state = self.state()
            if action == 'start':
                if state == 'stopped':
                    self.idle_since = None
                    self.ec2.start_instances(InstanceIds=[self.instance])
                    self.stopping = False
                    return 200, {'state': 'pending', 'ready': False, 'activeSessions': 0}
                if state not in ('pending', 'running'): return 409, {'error': 'Wait for the server to finish stopping.'}
            elif action == 'stop':
                if state == 'stopped': return 200, {'state': state, 'ready': False, 'activeSessions': 0}
                if state != 'running' or self.stopping: return 409, {'error': 'Wait for the server state to settle.'}
                # Fail closed if the worker cannot attest that every session has cleaned up.
                health = self.worker()
                if health['activeSessions'] != 0: return 409, {'error': 'End all native previews before stopping the server.'}
                self.ec2.stop_instances(InstanceIds=[self.instance])
                self.stopping = True
                return 200, {'state': 'stopping', 'ready': False, 'activeSessions': 0}
            else: return 404, {}
            return 200, self.status()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def reply(self, status, body):
        raw = json.dumps(body).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(raw)

    def handle_request(self):
        self.connection.settimeout(15)
        control = self.server.control
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + control.token):
            self.reply(401, {}); return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if not 0 <= length <= 2048: self.reply(400, {}); return
            if self.path == '/instance' and self.command == 'GET':
                with control.lock: self.reply(200, control.status())
                return
            if self.path in ('/instance/start', '/instance/stop') and self.command == 'POST' and length == 0:
                self.reply(*control.action(self.path.rsplit('/', 1)[1])); return
            match = re.fullmatch(r'/sessions/[a-f0-9-]{36}(/video|/input)?', self.path)
            if not match or self.command not in ('GET', 'POST', 'DELETE'):
                self.reply(404, {}); return
            body = self.rfile.read(length) if length else None
            connection = http.client.HTTPConnection('127.0.0.1', control.worker_port, timeout=12)
            try:
                # Serialize new-session acceptance with the idle check and AWS stop action.
                starting = self.command == 'POST' and match[1] is None
                if starting:
                    with control.lock:
                        if control.stopping or control.state() != 'running':
                            self.reply(409, {'error': 'Start the Android server first.'}); return
                        control.idle_since = None
                        connection.request(self.command, self.path, body, {'Authorization': 'Bearer '+control.token, 'Content-Type': 'application/json'})
                        response = connection.getresponse()
                else:
                    connection.request(self.command, self.path, body, {'Authorization': 'Bearer '+control.token, 'Content-Type': 'application/json'})
                    response = connection.getresponse()
                self.send_response(response.status)
                for name in ('Content-Type', 'Content-Length'):
                    value = response.getheader(name)
                    if value is not None: self.send_header(name, value)
                self.send_header('Cache-Control', 'no-store')
                self.send_header('X-Accel-Buffering', 'no')
                self.end_headers()
                while True:
                    chunk = response.read1(65536)
                    if not chunk: break
                    self.wfile.write(chunk); self.wfile.flush()
            finally: connection.close()
        except (BrokenPipeError, ConnectionResetError): pass
        except Exception as error:
            # Never log tokens, request bodies, AWS credentials or upstream payloads.
            print('Controller request failed: '+type(error).__name__, flush=True)
            try: self.reply(503, {'error': 'Android server unavailable. Retry shortly.'})
            except OSError: pass

    do_GET = do_POST = do_DELETE = handle_request


def main():
    import boto3
    from botocore.config import Config
    token = os.environ['MOBILE_ANDROID_PREVIEW_WORKER_TOKEN']
    if len(token) < 32: raise ValueError('Require strong bearer token')
    instance = os.environ['ANDROID_EC2_INSTANCE_ID']
    if not re.fullmatch('i-[a-f0-9]{17}', instance): raise ValueError('Invalid fixed instance')
    ec2 = boto3.client('ec2', region_name=os.environ['AWS_REGION'], config=Config(connect_timeout=2, read_timeout=3, retries={'max_attempts': 1}))
    server = ThreadingHTTPServer(('127.0.0.1', 19097), Handler)
    server.control = Control(ec2, instance, token)
    shutdown = threading.Event()
    monitor = threading.Thread(target=server.control.monitor_idle, args=(shutdown,), daemon=True)
    monitor.start()
    try: server.serve_forever()
    finally:
        shutdown.set()
        server.server_close()

if __name__ == '__main__': main()
