# Release checks

Candidate packaging, readiness packets, quality gates, and transaction reliability checks live here. Begin with [release preparation](../../tasks/release-preparation.md) and the [release readiness procedure](../../../commerce-docs/platform/operations/release-readiness.md).

`build-frontend.sh` builds the complete static website, storefront, store admin,
and mobile admin export inside the supplied ephemeral Node build container. It
expects the repository mounted at `/source`, copies it to `/app`, writes the
candidate export to `/public`, and uses `DOMAIN` for the public URLs. It is a
candidate-build recipe; production deployment only verifies and promotes the
reviewed export. The old `deploy/ec2/build-frontend.sh` path forwards here.

`release_readiness.py` initializes and checks an evidence packet for an exact candidate and installation. Other entry points run focused release or reliability checks; inspect their required services and outputs in the [command reference](../../../commerce-docs/platform/reference/scripts.md). Deployment launchers are under [`deploy/`](../../deploy/README.md).
