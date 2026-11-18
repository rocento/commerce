# MinIO restrictions for the media service

This build retains official source release `RELEASE.2025-10-15T17-29-55Z`
(`9e49d5e7a648`). It adds a local implementation of the upstream workaround for
[CVE-2026-40344](https://github.com/minio/minio/security/advisories/GHSA-9c4q-hq6p-c237)
and [CVE-2026-41145](https://github.com/minio/minio/security/advisories/GHSA-hv4r-mvr4-25vw).
It is not an upstream security release or an assertion that other findings are fixed.

The S3 HTTP authentication middleware rejects every request containing the
`STREAMING-UNSIGNED-PAYLOAD-TRAILER` value in `X-Amz-Content-Sha256`, before
authentication classification and downstream route handling. It checks duplicate
and comma-combined values, trims surrounding whitespace, and compares header
names and values without case sensitivity. This intentionally rejects the unsigned
trailer mode for all methods and authentication types. Ordinary signed operations
and the signed trailer mode remain supported. Clients using unsigned trailers must
switch to ordinary signed uploads or signed trailers.

`cmd/routers.go` in the pinned source applies `globalMiddlewares`, including
`setAuthMiddleware`, to the router after registering the S3 routes. Therefore this
guard also covers direct S3 access and forwarded requests before routing. The
patch retains upstream error responses, audit logging, and rejected-auth counters.

The Docker build applies the patch with zero fuzz and runs the focused Go tests
before producing the binary. These tests verify denial before the next handler
and that other payload modes reach that handler; they do not claim to validate
signatures. `verify-unsigned-trailer.py` separately checks real signed bucket and
object operations plus ordinary denied requests in a disposable, loopback-only,
tmpfs-backed container. It generates no exploit payloads, uses random credentials,
prints no secrets, and removes its container and network.

Example, after building the local candidate:

```sh
python3 minio/verify-unsigned-trailer.py --image <local-image-id> --output <report.json>
```

The locally patched main module can appear as `(devel)` in Go build metadata.
Image labels and the release source manifest record its exact upstream source and
local patch. A scanner losing the original MinIO advisory match is not remediation
evidence: carry forward the original findings and distinguish this protocol
mitigation from unresolved MinIO, dependency, and operating-system findings.
Release security review and independent approval remain required.

## Unsupported S3 Select and replication

The second patch implements restrictions based on the documented workarounds for
[CVE-2026-39414](https://github.com/minio/minio/security/advisories/GHSA-h749-fxx7-pwpg)
and [CVE-2026-34204](https://github.com/minio/minio/security/advisories/GHSA-3rh2-v3gr-35p9).
Before authentication dispatch, it rejects any decoded query key named `select`,
and any header whose name starts with `X-Minio-Replication-` or equals
`X-Minio-Source-Replication-Request` (header names are compared without case
sensitivity). It returns the existing S3 `NotImplemented` response. Query matching
uses Go's URL parser, including percent-decoding and duplicate keys. S3 query names
are case-sensitive; the registered S3 Select route uses lowercase `select`.

These restrictions are deliberately broader than the advisory examples: this
single-store media service does not support S3 Select or replication, including
requests that supply a replication marker. The frozen merchant renderer starts
`minio server /data` with root credentials and no replication configuration. Its
`infra-media::Store` client performs bucket initialization and ordinary signed
object put (with content type), get and delete; it does not set replication headers
or send Select requests. Ordinary object names or query values containing the word
`select`, user metadata and multipart route parameters remain unaffected by the
guard. Adding replication or S3 Select later requires an implementation and fresh
security review; these guards must not simply be removed.

Focused tests cover the restrictions before downstream handlers, and the local
runtime script uses only ordinary bodies and harmless placeholder header values.
It verifies rejection and absence of created objects, then repeats signed reads
and deletes. No malformed storage data, exploit payloads or production targets are
used. The four affected MinIO source findings remain recorded as protocol
mitigations pending independent review, not as upstream fixes.

## Pinned Go networking and text dependencies

`go-network-security.patch` updates `golang.org/x/net` to `v0.62.0` and the eight
Go submodule versions selected by its dependency requirements: `x/crypto v0.58.0`,
`x/net v0.62.0`, `x/text v0.43.0`, `x/sys v0.49.0`, `x/sync v0.24.0`,
`x/term v0.47.0`, `x/mod v0.41.0`, and `x/tools v0.51.0`. The Go requirement becomes
1.26; the builder remains pinned to Go 1.26.11. Exact module checksums are included
in the patch, and subsequent tests/build use `-mod=readonly` and
`GOTOOLCHAIN=local`.

The dependency graph includes `x/text/unicode/norm` through the embedded console
client and IDNA, so its
[invalid UTF-8 iterator issue](https://pkg.go.dev/vuln/GO-2026-5970) merits a direct
update. The networking update also includes the published HTTP/2, IDNA and parser
fixes identified by the release scan, plus required crypto updates. It changes no
cloud, gRPC, Prometheus or OpenTelemetry module versions. The Docker build runs the
upstream normalization and IDNA package tests in addition to the local middleware
tests. Remaining findings require their own dependency-path/configuration review;
this update is not a blanket security clearance.
