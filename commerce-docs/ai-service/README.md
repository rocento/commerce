# AI service documentation

This folder owns documentation for `commerce-assistant-platform`, including its Python application and Node language engine.

| Guide | Contents |
| --- | --- |
| [Architecture](architecture.md) | Runtime flow, engine ownership, security and change rules |
| [Code map](code-map.md) | Source locations and focused validation |
| [Local development](local-development.md) | Installation, startup, tests and evaluation |
| [DBeaver database access](database-access.md) | Local/shared-production topology, SSH settings and protected credential locations |
| [Shared AI database operations](shared-database-operations.md) | Tenant isolation, coordinated deployment, migration and recovery |
| [Language release upgrade](language-release-upgrade.md) | Immutable drafts, exact evaluation, explicit promotion and rollback |
| [API](api.md) | Python routes, SSE and Node resolver interfaces |
| [Configuration and operations](configuration.md) | Identity, providers, persistence, release checks and troubleshooting |
| [Language and capabilities](language-and-capabilities.md) | Interpretation, supported workflows, fallback and compound limits |
| [Generated intent inventory](intent-action-coverage.md) | Source-derived dispatch routes and reviewed execution boundaries |
| [Database recognition rules](database-recognition-rules.md) | Database-owned definitions, authoring, storage and release verification |
| [Database quality and evaluation](database-quality-upgrade.md) | Evaluation reporting, reviewed datasets and feedback workflows |
| [Knowledge authoring](knowledge-authoring.md) | Inspect, compare and edit aliases in immutable drafts |
| [Vocabulary imports](enterprise-knowledge-vocabulary-expansion.md) | Reviewed sources, resumable imports and database tables |

## Plans and release history

- [Active plans](plans/README.md): enterprise knowledge priorities, acceptance gates and separate implementation/deployment status.
- [Release history](history/README.md): dated candidate results and publication records, including revision 12.

Use the operational guides above for new work. Historical reports retain exact evidence and recovery context; their commands and release identities require a fresh target check before reuse.

These guides describe source behavior, not verified deployment state. Feature availability depends on tenant configuration, gateway capabilities, persisted settings and active language artifacts.

The platform overview remains in [the repository README](../../commerce-api/README.md), with shared infrastructure guidance in [deployment](../../commerce-ops/deploy/ec2/README.md). Add future AI service documentation here instead of recreating Markdown under `commerce-assistant-platform` or separate assistant documentation trees.
