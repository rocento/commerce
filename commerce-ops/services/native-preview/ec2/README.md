# EC2 control API moved

The Android EC2 automation service, tests, IAM policies, and installer live in
the [native preview controller](../aws-controller/README.md). The old
`commerce-ops/deploy/aws-automation/` path remains a compatibility symlink.

The native emulator worker remains in `commerce-ops/services/native-preview`. Server runtime paths and public App Studio API routes are unchanged.
