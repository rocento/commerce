# Operations configuration and inventory

`examples/` contains safe templates for named workstation cloud targets. Copy
one into ignored `.local/commerce-ops/targets/`, fill its non-secret host and
key-path references, and follow the [target rules](../COMMANDS.md#named-targets-and-precedence).
Do not put real target values or private key contents in this source folder.

[entrypoints.json](entrypoints.json) inventories canonical executable and data paths.
The public operator catalog remains [commands.json](../commands.json); it describes
command routes, effects and runbooks. `examples/` is the single maintained source
for provider target defaults; the former provider template aliases have been retired.

The dispatcher delegates named-target parsing and resolution to
[`cloud/lib/targets.py`](../cloud/lib/targets.py). This workstation-only helper
preserves CLI/environment/file precedence and validates provider restrictions;
it does not execute configuration values or initiate connections. Direct provider
launchers retain their existing shell target loaders.
