# Local platform

`local-compose.sh` starts the `commerce-ai` Compose project. Pass `--assistant`
to include the local assistant and language services. `local-demo-compose.sh`
selects one of the existing demo project identities. Run both from any working
directory; they resolve the repository root themselves.

Start with the [local development task](../../tasks/local-development.md) and
the [local setup procedure](../../../commerce-docs/platform/operations/local-setup.md).
`initialize-assistant-storage.py` prepares local assistant credentials, storage,
and migrations. The other Python files in this folder support local credentials,
admin bootstrap, knowledge setup, and demo assistant setup.

The `scripts/local/` versions of these names are migration symlinks. New
callers should use this folder directly.
