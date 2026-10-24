# Commerce operations agent guide

Use [README.md](README.md) to route work to the right operations task guide.
This directory coordinates workflows; it does not take ownership of application
code maintained in `commerce-api/`, `commerce-web/`, or
`commerce-assistant-platform/`.

## Ownership boundaries

- `compose/base/` owns shared services and persistent identities;
  `compose/components/` owns optional reusable services; and
  `compose/overlays/` owns local, cloud, and demo-specific settings.
  Commands selecting nested Compose files must set the Compose project directory
  to `commerce-ops/compose` so build contexts and mounts keep resolving.
- `local/` owns workstation launchers, setup, onboarding dependencies, and
  preview helpers.
- `workflows/` owns release, demo and maintenance procedures implemented in code.
  Read its agent guide before moving command dependencies.
- `tools/` owns checks, contract generators, asset generators and evaluation tooling.
- `tests/operations/` owns the operations regression suite; service tests stay
  with their services.
- `scripts/` retains historical evidence harnesses and compatibility paths; see its
  [agent guide](scripts/AGENTS.md).
- `cloud/` owns provider adapters, shared transport, and canonical host operations.
- `services/` owns assistant, contact, health-dashboard, observability, rengine and native-preview
  installation/configuration assets. Keep application runtimes with their apps.
- `deploy/` contains remaining deployment assets and compatibility paths; see its
  [agent guide](deploy/AGENTS.md) before changing those boundaries.
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

## Documentation ownership

- `README.md` owns task routing; `COMMANDS.md` owns invocation and target rules;
  `tasks/` owns operator procedures. Keep the existing `tasks/` name.
- `REFACTOR-PLAN.md` owns migration status and the next steps. Update it instead
  of creating a new phase report or progress Markdown file.
- Create an area README only for a distinct ownership or dependency boundary.
  Link to existing procedures instead of copying them into folder guides.
- Provider guides own access/setup differences; shared tasks describe the
  common workflow. State supported AWS/GCP capabilities accurately.
- Follow the plan's consolidation map. Before removing a document, preserve
  unique content and update inbound links, catalog paths, and checker coverage.
- Keep historical validation claims attached to their original batch; report
  current validation separately.

## Naming

Use lowercase kebab-case for folders and shell commands, snake_case for
importable Python modules, and the owning language's conventions elsewhere.
Name commands for their action and domain. Preserve public CLI arguments and
installed filenames until all consumers migrate; do not rename systemd units,
Compose identities, or runtime data paths merely for source consistency.

For Python, distinguish executable wrappers from importable modules: a
`check-domain.py` command may delegate to `check_domain.py`. Do not rename
importable packages to kebab-case or rename published commands merely to match
module spelling. Historical phase filenames and installed `ec2-*` adapters
retain their documented identities. Folder guides own local boundaries, not
copies of the root task menu or step-by-step procedures from task guides.
