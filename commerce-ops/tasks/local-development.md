# Local platform development

Use this workflow for the shared commerce stack on a developer workstation.

## Start the stack

From the repository root:

```sh
cp .env.example .env  # only when .env does not already exist
python3 commerce-ops/bin/ops local platform up
```

Use `local platform status`, `logs`, or `down` through the same dispatcher. Add
`--assistant` to include the local assistant services after their storage is
initialized with `python3 commerce-ops/bin/ops local assistant setup`.

The launcher uses the canonical Compose files in `commerce-ops/compose/` and
preserves the `commerce-ai` project identity so existing local volumes remain
attached. See the [Compose guide](../compose/README.md) for overlays and the
[local setup guide](../../commerce-docs/platform/operations/local-setup.md) for service
configuration.

## Ownership

- API and database code: `commerce-api/`
- Web applications: `commerce-web/`
- Assistant services: `commerce-assistant-platform/`
- Shared local service wiring and launcher: `commerce-ops/compose/` and
  `commerce-ops/local/platform/`

Edit implementation in its owning service. Change operations wiring here only
when the shared local platform workflow needs it.
