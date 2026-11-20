"""Loopback HTTPS bridge for native-preview acceptance. Never use as production ingress."""

# Keep existing sibling-module imports available to direct and compatibility callers.
import sys as _sys
from pathlib import Path as _Path
_sys.path.insert(0, str(_Path(__file__).resolve().parents[3] / "commerce-ops/scripts"))

import argparse
import http.client
import http.server
from pathlib import Path
import ssl


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cert', type=Path, required=True)
    parser.add_argument('--key', type=Path, required=True)
    parser.add_argument('--offline-marker', type=Path)
    args = parser.parse_args()

    class Proxy(http.server.BaseHTTPRequestHandler):
        def forward(self):
            if args.offline_marker and args.offline_marker.exists():
                self.send_error(503)
                return
            path = self.path.removeprefix('/api')
            if not path.startswith('/v1/mobile/preview/'):
                self.send_error(404)
                return
            length = int(self.headers.get('content-length', '0'))
            if length < 0 or length > 4096:
                self.send_error(413)
                return
            remote = http.client.HTTPConnection('127.0.0.1', 18094, timeout=20)
            try:
                remote.request(self.command, path, self.rfile.read(length), dict(self.headers))
                response = remote.getresponse()
                data = response.read(6 * 1024 * 1024)
                self.send_response(response.status)
                for key, value in response.getheaders():
                    if key.lower() not in ('transfer-encoding', 'connection', 'content-length'):
                        self.send_header(key, value)
                self.send_header('content-length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except (OSError, http.client.HTTPException):
                self.send_error(502)
            finally:
                remote.close()

        do_GET = forward
        do_POST = forward

        def log_message(self, *_args):
            pass  # Never log request paths, capabilities or payloads.

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(args.cert, args.key)
    with http.server.ThreadingHTTPServer(('127.0.0.1', 18443), Proxy) as server:
        server.socket = context.wrap_socket(server.socket, server_side=True)
        server.serve_forever()


if __name__ == '__main__':
    main()
