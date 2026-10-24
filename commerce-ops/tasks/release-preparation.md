# Release preparation

Use the [release readiness procedure](../../commerce-docs/platform/operations/release-readiness.md) as the source of truth for the candidate, evidence, owners, and gate order. The [release scripts guide](../workflows/release/README.md) identifies the supporting commands.

## Prepare the candidate

1. Identify the exact candidate and its inventory SHA-256, target installation, and release owner.
2. Create a release evidence directory under `commerce-output/` and initialize its readiness packet with `release_readiness.py init`.
3. Run the checks required by the [readiness procedure](../../commerce-docs/platform/operations/release-readiness.md) and record the evidence in that packet.
4. Run `release_readiness.py check` against the same packet, candidate digest, and installation ID. Review every reported failure before proceeding.

For example, the procedure shows the full `init` and `check` commands and the required arguments. Keep the evidence packet tied to one candidate digest; initialize a new packet when the candidate changes.

The [ops command interface](../COMMANDS.md) exposes these packet steps as
`release prepare` and `release check`. `prepare` initializes the packet in an
existing output directory; it does not create candidate artifacts or complete
the required evidence checks.

This task prepares evidence. To apply an approved candidate to production, follow [platform deployment](rocento-platform-deployment.md).
