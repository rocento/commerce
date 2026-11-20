# Local platform

`local-compose.sh` starts the `commerce-ai` Compose project. Pass `--assistant`
to include the local assistant and language services. `local-demo-compose.sh`
selects one of the existing demo project identities. Run both from any working
directory; they resolve the repository root themselves.

Start with the [local development task](../../tasks/local-development.md) and
the [local setup procedure](../../../commerce-docs/platform/operations/local-setup.md).
`create-assistant-credentials.py` creates missing local credentials.
`initialize-assistant-storage.py` prepares local assistant credentials, storage,
and migrations. The other Python files in this folder support local credentials,
admin bootstrap, knowledge setup, and demo assistant setup.

The old `scripts/local/` aliases have been removed. Use this folder directly.
