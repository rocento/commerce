#!/usr/bin/env python3
"""Private Android emulator worker. Requires SDK emulator/adb and Pillow.

Uses disposable, worker-owned AVD data and the same authenticated transport as iOS.
The operator selects the system image and signed APKs; clients supply neither.
"""
import argparse
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import signal
import struct
import subprocess
import threading
import time
import grpc
from android_capture import EmulatorCapture
from android_avd import GPU_MODE, create_avd, system_ui_ready, validate_seed
from interactive import validate_input, MAX_JPEG
from worker import Worker, Handler, ThreadingHTTPServer, run

class AndroidInput:
    def __init__(self, stop, publish, capture, fps=24):
        if type(fps) is not int or not 1 <= fps <= 60:
            raise ValueError('capture fps must be an integer in 1..60')
        self.fps = fps
        self.stop, self.publish = stop, publish
        self.capture = capture
        self.lock = threading.Lock()
        self.sequence = 0
        self.width = self.height = 0

    def run(self):
        failures = 0
        next_capture = time.monotonic()
        while not self.stop.is_set():
            try:
                with self.capture() as screen:
                    self.width, self.height = screen.size
                    screen.thumbnail((540, 1200))
                    output = io.BytesIO()
                    screen.convert('RGB').save(output, 'JPEG', quality=60)
                    payload = output.getvalue()
                    # Compatible JPEG comment: browsers can detect transport backlog
                    # without changing the shared iOS/Android framing protocol.
                    payload = payload[:2] + b'\xff\xfe\x00\x0eROCT' + struct.pack('>d', time.time() * 1000) + payload[2:]
                    if len(payload) > MAX_JPEG:
                        raise RuntimeError('capture too large')
                    self.publish(payload)
                failures = 0
            except (OSError, grpc.RpcError):
                # A transient capture failure must not end an otherwise healthy session.
                # Persistent capture failures still fail closed; never publish a bad frame.
                failures += 1
                if failures >= 3:
                    raise
            # Bound CPU/bandwidth to the operator target; never queue old frames.
            # Schedule against a deadline so timer oversleep does not accumulate
            # into a lower frame rate. Drop missed deadlines rather than bursting.
            now = time.monotonic()
            next_capture = max(next_capture + 1 / self.fps, now)
            self.stop.wait(next_capture - now)

    def input(self, data):
        validate_input(data)
        with self.lock:
            if self.stop.is_set() or not self.width:
                return 503
            if data['sequence'] <= self.sequence:
                return 409
            self.sequence = data['sequence']
            try:
                self.capture.input(data, self.width, self.height, self.stop)
            except grpc.RpcError:
                raise RuntimeError('emulator input unavailable') from None
            return 204

    def close(self):
        self.stop.set()


class AndroidWorker(Worker):
    def __init__(self, args):
        self.args = args
        self.root = Path(args.state).resolve()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        os.chmod(self.root, 0o700)
        self.process_lock = (self.root / 'worker.lock').open('w')
        fcntl.flock(self.process_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.lock = threading.RLock()
        self.sessions, self.threads = {}, []
        self.artifacts = json.loads(Path(args.artifacts).read_text())
        self.sdk = Path(args.sdk).resolve()
        self.image = Path(args.system_image).resolve()
        if not (self.image / 'system.img').is_file() or not (self.image / 'kernel-ranchu').is_file():
            raise ValueError('installed SDK system image required')
        self.seed = validate_seed(args.seed, self.image) if args.seed else None
        self.ports = set()
        # A unique private adb server separates this worker from personal devices.
        self.adb_base = [str(self.sdk / 'platform-tools/adb'), '-P', str(args.adb_port)]
        for key, artifact in self.artifacts.items():
            parts = key.split(':')
            if len(parts) not in (2, 3) or (len(parts) == 3 and parts[2] != 'react-native'):
                raise ValueError('invalid artifact implementation')
            merchant, environment = parts[:2]
            if environment not in ('production', 'staging') or not re.fullmatch('[a-f0-9-]{36}', merchant):
                raise ValueError('invalid artifact scope')
            if not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_.]+', artifact['packageId']):
                raise ValueError('invalid package')
            if not re.fullmatch(r'[a-zA-Z][a-zA-Z0-9_.]+', artifact.get('activity', 'com.rocento.mobile.MainActivity')):
                raise ValueError('invalid activity')
            apk = Path(artifact['apk'])
            if hashlib.sha256(apk.read_bytes()).hexdigest() != artifact['sha256']:
                raise ValueError('artifact checksum mismatch')
            run('python3', args.signing_check, str(apk), '--sdk', str(self.sdk), '--package-id', artifact['packageId'],
                '--baseline-apk', str(apk), '--expected-cert-sha256', artifact['certificateSha256'])
        # Refuse crash residue rather than risking another process's emulator or personal AVD.
        if list(self.root.glob('session-*')):
            raise RuntimeError('recover prior worker session directories before restart')
        threading.Thread(target=self.reap, daemon=True).start()

    def simulate(self, sid, state, artifact, code):
        emulator = adapter = capture = None
        directory = self.root / ('session-' + sid)
        port = None
        cleanup_failed = False
        phase = 'prepare'
        started = time.monotonic()
        phase_started = started
        def mark(next_phase):
            nonlocal phase, phase_started
            now = time.monotonic()
            print(f'Android preview {phase}: {now - phase_started:.2f}s', flush=True)
            phase, phase_started = next_phase, now
        try:
            with self.lock:
                port = next(p for p in range(self.args.emulator_port, self.args.emulator_port + 2 * self.args.capacity, 2) if p not in self.ports)
                self.ports.add(port)
            directory.mkdir(mode=0o700)
            avd = create_avd(directory, self.image)
            if self.seed:
                # The emulator's initdata copy expands sparse images. Preserve holes
                # explicitly, then open this private existing disk as normal userdata.
                run('cp', '--sparse=always', '--reflink=auto', str(self.seed), str(avd / 'userdata-qemu.img'), timeout=60)
                shutil.copyfile(self.seed.parent / 'encryptionkey.img', directory / 'encryptionkey.img')
            runtime = directory / 'runtime'
            runtime.mkdir(mode=0o700)
            grpc_port = self.args.grpc_port + (port - self.args.emulator_port) // 2
            env = dict(os.environ, ANDROID_AVD_HOME=str(directory), ANDROID_ADB_SERVER_PORT=str(self.args.adb_port), XDG_RUNTIME_DIR=str(runtime))
            mark('boot')
            emulator = subprocess.Popen([str(self.sdk / 'emulator/emulator'), '-avd', 'RocentoWorker',
                '-port', str(port), '-no-window', '-no-audio', '-no-snapshot', '-no-boot-anim',
                '-gpu', GPU_MODE, '-accel', 'on',
                '-grpc', str(grpc_port), '-grpc-use-token',
                *(['-encryption-key', str(directory / 'encryptionkey.img')] if self.seed else [])], env=env,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            serial = 'emulator-' + str(port)
            def adb(*args, timeout=20):
                return run(*self.adb_base, '-s', serial, *args, timeout=timeout)
            run(*self.adb_base, 'start-server', timeout=10)
            deadline = time.monotonic() + 150
            while time.monotonic() < deadline:
                if state['stop'].wait(1) or emulator.poll() is not None: raise RuntimeError('emulator stopped')
                try:
                    if adb('shell', 'getprop', 'sys.boot_completed', timeout=3).strip() == b'1': break
                except Exception: pass
            else: raise RuntimeError('emulator boot timeout')
            # Do not compete with SystemUIService initialization by installing an
            # APK as soon as boot_completed flips. Its service startup may still
            # be executing (and subject to Android's 20-second ANR deadline).
            mark('system-ui')
            deadline = time.monotonic() + 45
            while time.monotonic() < deadline:
                if state['stop'].wait(1) or emulator.poll() is not None: raise RuntimeError('emulator stopped')
                try:
                    status = adb('shell', 'dumpsys', 'activity', 'services', 'com.android.systemui', timeout=5).decode()
                    if system_ui_ready(status): break
                except Exception: pass
            else: raise RuntimeError('System UI startup timeout')
            if b'am_anr' in adb('logcat', '-b', 'events', '-d', '-s', 'am_anr', timeout=5):
                raise RuntimeError('Android startup ANR')
            # Run the mandatory destination gate against this worker's private adb server.
            mark('install')
            signing_env = dict(os.environ, ANDROID_ADB_SERVER_PORT=str(self.args.adb_port), ADB_SERVER_SOCKET=f'tcp:localhost:{self.args.adb_port}')
            if hashlib.sha256(Path(artifact['apk']).read_bytes()).hexdigest() != artifact['sha256']:
                raise ValueError('artifact changed')
            run('python3', self.args.signing_check, artifact['apk'], '--sdk', str(self.sdk),
                '--package-id', artifact['packageId'], '--serial', serial,
                '--expected-cert-sha256', artifact['certificateSha256'], '--install', env=signing_env)
            # Capability enters only app-private files via stdin; never launch arguments/logs.
            mark('bootstrap')
            command = [*self.adb_base, '-s', serial, 'shell', '-T', 'run-as', artifact['packageId'],
                       'sh', '-c', "'umask 077; mkdir -p files && cat > files/studio-preview-code'"]
            result = subprocess.run(command, input=code.encode(), capture_output=True, timeout=10)
            if result.returncode: raise RuntimeError('preview bootstrap failed')
            del code
            mark('launch')
            adb('shell', 'am', 'start', '-W', '-n', artifact['packageId'] + '/' + artifact.get('activity', 'com.rocento.mobile.MainActivity'),
                '--ez', 'rocento-draft-preview', 'true')
            if not adb('shell', 'pidof', artifact['packageId']).strip():
                raise RuntimeError('native preview app did not start')
            def publish(payload):
                with self.lock:
                    if state['video_number'] == 0:
                        print(f'Android preview first frame: {time.monotonic() - started:.2f}s', flush=True)
                    state['video'] = payload
                    state['video_number'] += 1
                    state['captured'] = time.monotonic()
            mark('capture')
            discovery = runtime / 'avd' / 'running' / f'pid_{emulator.pid}.ini'
            if not discovery.is_file():
                discovery = discovery.with_name(f'pid_{emulator.pid}_info.ini')
            config = dict(line.split('=', 1) for line in discovery.read_text().splitlines() if '=' in line)
            if int(config.get('grpc.port', '0')) != grpc_port:
                raise RuntimeError('emulator capture endpoint mismatch')
            capture = EmulatorCapture(grpc_port, config['grpc.token'])
            adapter = AndroidInput(state['stop'], publish, capture, fps=self.args.fps)
            with self.lock: state['interactive'] = adapter
            adapter.run()
        except Exception as error:
            # Phase/type only: never print process arguments, capabilities or native output.
            print(f'Android preview failed during {phase}: {type(error).__name__}', flush=True)
            with self.lock: state['failed'] = True
        finally:
            if adapter: adapter.close()
            if capture: capture.close()
            if emulator:
                try:
                    emulator.terminate()
                    try: emulator.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        emulator.kill(); emulator.wait(timeout=10)
                except Exception: cleanup_failed = True
            if not cleanup_failed:
                shutil.rmtree(directory, ignore_errors=True)
                cleanup_failed = directory.exists()
            with self.lock:
                if not cleanup_failed and port is not None: self.ports.discard(port)
                state['finished'] = not cleanup_failed
                if state['stop'].is_set() and not cleanup_failed: self.sessions.pop(sid, None)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('artifacts', 'state', 'sdk', 'system-image', 'signing-check'):
        parser.add_argument('--' + name, required=True)
    parser.add_argument('--seed', default=os.environ.get('MOBILE_ANDROID_PREVIEW_SEED'), help='Validated OS-only pre-initialized userdata manifest')
    parser.add_argument('--capacity', type=int, default=1)
    parser.add_argument('--fps', type=int, choices=range(1, 61), metavar='1..60', default=24,
                        help='Capture target (1..60); delivered FPS depends on host and transport')
    parser.add_argument('--port', type=int, default=19096)
    parser.add_argument('--grpc-port', type=int, default=19500)
    parser.add_argument('--adb-port', type=int, default=5038)
    parser.add_argument('--emulator-port', type=int, default=5580)
    args = parser.parse_args()
    token = os.environ.get('MOBILE_ANDROID_PREVIEW_WORKER_TOKEN', '')
    if len(token) < 32 or not 1 <= args.capacity <= 8 or not 1024 <= args.grpc_port <= 65528 or args.emulator_port % 2 or not 5554 <= args.emulator_port <= 5668:
        parser.error('Require worker token, capacity 1..8 and even emulator port 5554..5668')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    server.token, server.worker = token, AndroidWorker(args)
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    try: server.serve_forever()
    finally:
        server.server_close()
        for sid in list(server.worker.sessions): server.worker.stop(sid)
        for thread in server.worker.threads: thread.join(timeout=240)


if __name__ == '__main__': main()
