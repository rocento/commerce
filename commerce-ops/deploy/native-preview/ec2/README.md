# EC2 control API moved

The Android EC2 automation service, tests, IAM policies, and installer live in
the [native preview controller](../../aws-automation/README.md). The old
`commerce-ops/deploy/aws-automation/` commands remain compatibility entry points.

The native emulator worker remains in `commerce-ops/deploy/native-preview`. Server runtime paths and public App Studio API routes are unchanged.
