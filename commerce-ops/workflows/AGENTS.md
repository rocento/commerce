# Workflow editing rules

Preserve public arguments, exit codes and imported functions. Keep one canonical
implementation; do not introduce root-level forwarding scripts. Update the
command catalog, entry-point inventory, CI, full/partial uploads and runbooks
with every move. Preserve streamed-through-stdin helpers as standalone sources.
Inspect `__file__` discovery, sibling imports and scratch-copy fixtures.

Run affected offline tests in `../tests/operations/`, including script layout,
command routing and deployment packaging. Use isolated fixtures for commands
that would write evidence or data. Do not deploy or seed production to validate
repository refactoring. See the root agent guide for compatibility boundaries.
