# Shared platform documentation

Start with [the repository quickstart](../../commerce-api/README.md) or the [service documentation index](../README.md). This section owns infrastructure and workflows shared by the services.

## Development and verification

- [Local setup and demo stacks](operations/local-setup.md)
- [Configuration](operations/configuration.md)
- [Testing and release verification](operations/testing.md)
- [Release readiness gate](operations/release-readiness.md)
- [Observability](operations/observability.md)
- [Commerce reliability baseline](operations/commerce-reliability.md)
- [Durability and recovery](operations/durability.md)

## Deployment and onboarding

- [EC2 and Cloudflare setup](deployment/aws-ec2-cloudflare.md)
- [Google Cloud Compute Engine deployment](../../commerce-ops/deploy/gcp-deploy/README.md)
- [Client catalog installation](deployment/client-onboarding.md)
- [Production release runbook](../../commerce-ops/deploy/aws-deploy/how.md)
- [Deployment configuration](../../commerce-ops/deploy/ec2/README.md)
- [Shared AI database operations](../ai-service/shared-database-operations.md)
- [Language release lifecycle](../ai-service/language-release-upgrade.md)
- [Hosting study](plans/dedicated-and-shared-hosting-study.md) — a design proposal, not deployed commerce isolation

## Reference and maintenance

- [Repository map](reference/repository-map.md)
- [Script reference](reference/scripts.md)
- [Entity identifiers](reference/entity-identifiers.md)
- [Documentation and cleanup policy](reference/workspace-cleanup.md)
- [Historical evidence catalog](evidence/README.md)

Keep service behavior in its owning guide and link to it here. Run `python3 commerce-ops/scripts/checks/check-documentation.py` after changing documentation.
