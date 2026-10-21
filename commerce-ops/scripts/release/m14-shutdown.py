"""Verify SIGTERM handling on a local liveness-only gateway (build the binary first)."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import os
from pathlib import Path
import signal
import socket
import subprocess
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[3]
with socket.socket() as sock:
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
env = {k: v for k, v in os.environ.items()
       if k not in ('DATABASE_URL', 'LOKI_URL', 'OTEL_EXPORTER_OTLP_ENDPOINT')}
env['BIND_ADDRESS'] = f'127.0.0.1:{port}'
env['RUST_LOG'] = 'info'
process = subprocess.Popen([str(ROOT / 'commerce-api/rocento-api/target/debug/api-gateway')], env=env,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
try:
    for _ in range(100):
        if process.poll() is not None:
            raise RuntimeError(process.communicate()[0].decode())
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}/health', timeout=.5).close()
            break
        except OSError:
            time.sleep(.1)
    else:
        raise RuntimeError('Gateway did not become ready')
    process.send_signal(signal.SIGTERM)
    output = process.communicate(timeout=10)[0].decode()
    assert process.returncode == 0, output
    assert 'shutdown requested' in output, output
    print('PASS gateway SIGTERM: healthy liveness-only process exited with code 0')
finally:
    if process.poll() is None:
        process.kill()
        process.wait()
