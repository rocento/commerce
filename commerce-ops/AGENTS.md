# Commerce operations agent guide

Use [README.md](README.md) to route work to the right operations task guide.
This directory coordinates workflows; it does not take ownership of application
code maintained in `commerce-api/`, `commerce-web/`, or
`commerce-assistant-platform/`.

## Ownership boundaries

- `compose/` owns shared local and Rocento service definitions.
- `scripts/` owns reusable operator and developer commands; see its
  [agent guide](scripts/AGENTS.md).
- `onboarding/` owns only local dependencies for onboarding API development.
- `deploy/` owns Rocento platform deployment tooling and inputs; see its
  [agent guide](deploy/AGENTS.md).
- `tasks/` explains workflows and links to canonical code. Keep procedures
  concise and avoid duplicating implementation details that drift.

## Safety and compatibility

- Preserve production paths under `/opt/rocento`, deployment locks, service
  identities, and Compose project names unless the task explicitly migrates
  them end to end.
- Do not add secrets, machine-specific state, or generated deployment output to
  source uploads or version control.
- Treat platform deployment, demo data seeding, and customer onboarding as
  separate workflows with separate approvals and owners.
- Update CI path filters and partial upload manifests when moving owned files.
- Do not run production deployment commands while doing repository refactoring.
