"""Exercise the actual Compose health commands against local HTTP responses."""
import json
import socket
import socketserver
import subprocess
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def command(service, port):
    filename, original = {
        'assistant': ('compose.assistant.yaml', 8000),
        'language': ('compose.language-engine.yaml', 3000),
    }[service]
    line = next(line.strip()[6:] for line in (ROOT / 'commerce-ops/compose' / filename).read_text().splitlines()
                if line.strip().startswith('test: ["CMD",'))
    args = json.loads(line)
    assert args.pop(0) == 'CMD'
    # Compose escapes dollars before passing them to the container's shell.
    return [arg.replace('$$', '$').replace(str(original), str(port)) for arg in args]


@pytest.mark.parametrize('service', ['assistant', 'language'])
@pytest.mark.parametrize('kind,successful', [
    ('healthy', True), ('unavailable', False), ('missing', False),
    ('fragmented', True), ('malformed', False), ('closed', False),
    ('timeout', False),
])
def test_health_probe_response(service, kind, successful):
    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            self.request.recv(4096)
            if kind == 'closed':
                return
            if kind == 'timeout':
                time.sleep(2.5)
                return
            status = {'unavailable': 503, 'missing': 404}.get(kind, 200)
            response = f'HTTP/1.1 {status} Status\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}'.encode()
            if kind == 'malformed':
                response = b'not-http 200 status\r\n\r\n'
            if kind == 'fragmented':
                self.request.sendall(response[:8])
                time.sleep(.03)
                response = response[8:]
            self.request.sendall(response)

    with socketserver.TCPServer(('127.0.0.1', 0), Handler) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        started = time.monotonic()
        result = subprocess.run(command(service, server.server_address[1]),
                                capture_output=True, timeout=4)
        elapsed = time.monotonic() - started
        server.shutdown()
        worker.join()
    assert (result.returncode == 0) is successful
    if kind == 'timeout':
        assert elapsed < 3


@pytest.mark.parametrize('service', ['assistant', 'language'])
def test_health_probe_refused_connection(service):
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    # Close before connecting: macOS may drop SYNs to a bound non-listener.
    result = subprocess.run(command(service, port), capture_output=True, timeout=4)
    assert result.returncode != 0
