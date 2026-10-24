# Operations tests

Regression tests for operations scripts and deployment layout live here. Tests use Python's test tooling and local fixtures; choose the relevant test file when changing a command. Some tests inspect maintained documentation or deployment paths.

The public interface is listed in [commands.json](../../commands.json); implementation and data paths are inventoried in [entrypoints.json](../../config/entrypoints.json). When a command moves, update its callers, inventory, and affected tests together. See [scripts editing rules](../../AGENTS.md).
