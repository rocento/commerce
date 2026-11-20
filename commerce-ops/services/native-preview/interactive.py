"""Private idb capture/input adapter. No browser-supplied commands or device IDs."""
import json
import math
import select
import struct
import subprocess
import threading
import time
from pathlib import Path

MAX_JPEG = 2 * 1024 * 1024
KEYS = {'Enter': 40, 'Backspace': 42, 'Tab': 43, 'Escape': 41,
        'ArrowRight': 79, 'ArrowLeft': 80, 'ArrowDown': 81, 'ArrowUp': 82, 'Delete': 76}


def validate_input(data):
    if not isinstance(data, dict) or type(data.get('sequence')) is not int or not 0 < data['sequence'] < 2**53:
        raise ValueError('invalid sequence')
    fields = {'tap': {'x', 'y'}, 'swipe': {'x', 'y', 'endX', 'endY', 'duration'},
              'text': {'text'}, 'key': {'key'}}
    kind = data.get('kind')
    if kind not in fields or set(data) != {'kind', 'sequence'} | fields[kind]:
        raise ValueError('invalid input')
    for key in fields[kind] - {'text', 'key'}:
        value = data[key]
        if type(value) not in (float, int) or not math.isfinite(value):
            raise ValueError('invalid coordinate')
        if not (0.05 <= value <= 1.5 if key == 'duration' else 0 <= value <= 1):
            raise ValueError('input out of range')
    if kind == 'text' and (not isinstance(data['text'], str) or not 1 <= len(data['text']) <= 128
                           or any(ord(c) < 32 or ord(c) > 126 for c in data['text'])):
        raise ValueError('Use printable English keyboard characters')
    if kind == 'key' and data['key'] not in KEYS:
        raise ValueError('unsupported key')
    return data


def exact(pipe, size, stop):
    result = bytearray()
    deadline = time.monotonic() + 15
    while len(result) < size:
        if stop.is_set() or time.monotonic() > deadline:
            raise RuntimeError('capture stopped or stalled')
        if not select.select([pipe], [], [], 0.5)[0]:
            continue
        chunk = pipe.read(size - len(result))
        if not chunk:
            raise RuntimeError('capture ended')
        result.extend(chunk)
    return bytes(result)


def frames(pipe, stop):
    header = exact(pipe, 2, stop)
    if header[0] != 1 or not 24 <= header[1] <= 64:
        raise ValueError('invalid minicap header')
    exact(pipe, header[1] - 2, stop)
    while not stop.is_set():
        size = struct.unpack('<I', exact(pipe, 4, stop))[0]
        if not 4 <= size <= MAX_JPEG:
            raise ValueError('invalid video frame length')
        frame = exact(pipe, size, stop)
        if not frame.startswith(b'\xff\xd8') or not frame.endswith(b'\xff\xd9'):
            raise ValueError('invalid JPEG')
        yield frame


class Interactive:
    def __init__(self, device, device_set, root, stop, publish, fps=30):
        if type(fps) is not int or not 1 <= fps <= 60:
            raise ValueError('capture fps must be an integer in 1..60')
        self.stop = stop
        self.publish = publish
        self.socket = Path(root) / (device + '.sock')
        self.processes = []
        self.input_lock = threading.Lock()
        self.sequence = 0
        self.ready = False
        self.companion = self.spawn(['idb_companion', '--udid', device, '--device-set-path', str(device_set),
            '--grpc-domain-sock', str(self.socket), '--log-level', 'info', '--log-hid-details', 'false'])
        try:
            for _ in range(100):
                if self.socket.exists(): break
                if stop.wait(.1) or self.companion.poll() is not None: raise RuntimeError('companion unavailable')
            description = json.loads(self.command('describe', '--json'))['screen_dimensions']
            self.width, self.height = description['width_points'], description['height_points']
            if not (100 <= self.width <= 4096 and 100 <= self.height <= 4096):
                raise ValueError('invalid native dimensions')
            self.capture = self.spawn(self.args('video-stream', '--format', 'minicap', '--fps', str(fps),
                '--scale-factor', '0.5', '--compression-quality', '0.7'), capture=True)
            self.ready = True
        except Exception:
            self.close()
            raise

    def args(self, *args):
        return ['idb', '--log', 'ERROR', '--companion', str(self.socket), *args]

    def spawn(self, args, capture=False):
        process = subprocess.Popen(args, stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, bufsize=0)
        self.processes.append(process)
        return process

    def command(self, *args):
        result = subprocess.run(self.args(*args), capture_output=True, timeout=8)
        if result.returncode: raise RuntimeError('native input unavailable')
        return result.stdout

    def run(self):
        for frame in frames(self.capture.stdout, self.stop):
            self.publish(frame)

    def input(self, data):
        validate_input(data)
        if not self.input_lock.acquire(blocking=False): return 409
        try:
            if self.stop.is_set() or not self.ready: return 404
            if data['sequence'] <= self.sequence: return 409
            # Consume before executing: a lost response must never replay a gesture.
            self.sequence = data['sequence']
            kind = data['kind']
            point = lambda x, y: [str(round(data[x] * (self.width - 1))), str(round(data[y] * (self.height - 1)))]
            if kind == 'tap': self.command('ui', 'tap', *point('x', 'y'))
            elif kind == 'swipe': self.command('ui', 'swipe', *point('x', 'y'), *point('endX', 'endY'), '--duration', str(data['duration']))
            elif kind == 'key': self.command('ui', 'key', str(KEYS[data['key']]))
            else: self.command('ui', 'text', '--', data['text'])
            return 204
        finally:
            self.input_lock.release()

    def close(self):
        self.ready = False
        for process in reversed(self.processes):
            if process.poll() is None:
                process.terminate()
                try: process.wait(timeout=5)
                except subprocess.TimeoutExpired: process.kill(); process.wait()
        self.socket.unlink(missing_ok=True)
