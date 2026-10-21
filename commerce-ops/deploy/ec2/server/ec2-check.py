#!/usr/bin/env python3
"""Small, deterministic HTTPS/readiness checks for the EC2 deployment."""
import argparse
import hashlib
import http.client
import json
import socket
import ssl
import sys
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    return 1


class PinnedOriginHTTPSConnection(http.client.HTTPSConnection):
    """Connect directly to an origin IP while retaining HTTPS SNI and Host."""
    def __init__(self, host, origin_ip, expected_sha256, **kwargs):
        super().__init__(host, context=ssl._create_unverified_context(), **kwargs)
        self.origin_ip = origin_ip
        self.expected_sha256 = expected_sha256

    def connect(self):
        raw = socket.create_connection((self.origin_ip, self.port), self.timeout)
        try:
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
            presented = hashlib.sha256(self.sock.getpeercert(binary_form=True)).hexdigest()
            if presented != self.expected_sha256:
                raise ssl.SSLError('origin certificate fingerprint does not match the configured certificate')
        except Exception:
            raw.close()
            raise


class PinnedOriginHTTPSHandler(urllib.request.HTTPSHandler):
    def __init__(self, origin_ip, expected_sha256):
        super().__init__(context=ssl._create_unverified_context())
        self.origin_ip = origin_ip
        self.expected_sha256 = expected_sha256

    def https_open(self, req):
        return self.do_open(
            lambda host, **kwargs: PinnedOriginHTTPSConnection(
                host, self.origin_ip, self.expected_sha256, **kwargs
            ),
            req,
        )


def response(url, context=None, origin_ip=None, origin_cert=None):
    request = urllib.request.Request(url, headers={"User-Agent": "Rocento-deploy/1"})
    handlers = [NoRedirect()]
    if origin_ip:
        if not origin_cert:
            raise RuntimeError('Direct-origin checks require the configured origin certificate for pinning.')
        with open(origin_cert, 'rb') as cert_file:
            der = ssl.PEM_cert_to_DER_cert(cert_file.read().decode('ascii'))
        fingerprint = hashlib.sha256(der).hexdigest()
        handlers.insert(0, urllib.request.ProxyHandler({}))
        handlers.append(PinnedOriginHTTPSHandler(origin_ip, fingerprint))
    else:
        handlers.append(urllib.request.HTTPSHandler(context=context) if context else urllib.request.HTTPSHandler())
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(request, timeout=30) as result:
            return result.status, result.headers, result.read(8192)
    except urllib.error.HTTPError as error:
        return error.code, error.headers, error.read(8192)
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        raise RuntimeError(str(error)) from error


def diagnose_public(host, path, origin_ip=None, origin_cert=None):
    url = f"https://{host}{path}"
    try:
        status, headers, body = response(url, origin_ip=origin_ip, origin_cert=origin_cert)
    except RuntimeError as error:
        route = f"direct origin {origin_ip}" if origin_ip else "DNS/Cloudflare origin"
        return fail(f"Cannot reach {url} through {route}: {error}. Check DNS, ingress firewall, Nginx, and TLS configuration.")
    location = headers.get("Location", "")
    server = headers.get("Server", "")
    text = body.decode("utf-8", "replace")
    if status in (301, 302, 307, 308):
        if location.rstrip("/") == url.rstrip("/") or location.startswith("http://"):
            return fail("Cloudflare/origin returned an HTTPS redirect loop. Set Cloudflare SSL/TLS encryption mode to Full (strict), never Flexible.")
        return fail(f"Unexpected redirect from {url} to {location or '(missing Location header)'}.")
    if status == 403 and ("1010" in text or "cloudflare" in server.lower()):
        return fail("Cloudflare returned 403/1010. Check Security Events and create a narrowly scoped rule for the request; do not disable TLS or Cloudflare security.")
    if status >= 520 and "cloudflare" in server.lower():
        return fail(f"Cloudflare returned {status}. Check the origin certificate, Full (strict), Nginx, EC2 security group port 443, and origin reachability.")
    if not 200 <= status < 400:
        return fail(f"{url} returned HTTP {status}. Response begins: {text[:180]!r}")
    print(f"[OK] {url} -> HTTP {status}")
    return 0


def ready(url, cafile=None, origin_ip=None, origin_cert=None):
    context = ssl.create_default_context(cafile=cafile) if cafile else None
    try:
        status, headers, body = response(url, context, origin_ip, origin_cert)
    except RuntimeError as error:
        return fail(f"Cannot reach {url}: {error}")
    content_type = headers.get_content_type()
    if status != 200 or content_type != "application/json":
        return fail(f"{url} returned HTTP {status} with Content-Type {content_type}; expected JSON readiness response.")
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return fail(f"{url} returned invalid JSON readiness data.")
    if payload.get("status") != "ready" or payload.get("dependencies", {}).get("database") != "ready":
        return fail(f"{url} is not ready: {json.dumps(payload, sort_keys=True)}")
    print(f"[OK] {url} ready")
    return 0


def dns(host):
    try:
        addresses = sorted({entry[4][0] for entry in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)})
    except socket.gaierror as error:
        return fail(f"DNS lookup failed for {host}: {error}. Create the Cloudflare DNS record and wait for propagation.")
    print(f"[OK] DNS {host}: {', '.join(addresses)}")
    return 0


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    ready_parser = sub.add_parser("ready")
    ready_parser.add_argument("--url", required=True)
    ready_parser.add_argument("--ca-file")
    ready_parser.add_argument("--resolve-ip", help="Connect directly to this IP and pin the presented certificate to --origin-cert.")
    ready_parser.add_argument("--origin-cert", help="Configured PEM certificate required when using --resolve-ip.")
    public_parser = sub.add_parser("public")
    public_parser.add_argument("--host", required=True)
    public_parser.add_argument("--path", default="/")
    public_parser.add_argument("--resolve-ip", help="Connect directly to this IP and pin the presented certificate to --origin-cert.")
    public_parser.add_argument("--origin-cert", help="Configured PEM certificate required when using --resolve-ip.")
    dns_parser = sub.add_parser("dns")
    dns_parser.add_argument("--host", required=True)
    args = parser.parse_args()
    if args.command == "ready":
        return ready(args.url, args.ca_file, args.resolve_ip, args.origin_cert)
    if args.command == "public":
        return diagnose_public(args.host, args.path, args.resolve_ip, args.origin_cert)
    return dns(args.host)


if __name__ == "__main__":
    sys.exit(main())
