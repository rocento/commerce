# Customer onboarding development

This guide is for developing the customer onboarding product. The local
infrastructure folder under `commerce-ops/onboarding/` is only a dependency
stack; it is not a production onboarding or merchant provisioning deployment.

## Start the API locally

Follow [`commerce-api/onboard-api/README.md`](../../commerce-api/onboard-api/README.md)
from the `commerce-api/onboard-api/` directory. It covers the local environment,
isolated PostgreSQL/NATS/registry dependencies, database migration, and API
startup. Its Compose file is
[`commerce-ops/onboarding/compose.yaml`](../onboarding/compose.yaml).

The browser-local preview and customer/staff interfaces are documented in the
[onboarding project guide](../../commerce-docs/onboarding/README.md).

## Ownership

- API, schema, and migration binary: `commerce-api/onboard-api/`
- Customer onboarding interface: `commerce-web/apps/onboarding/`
- Staff interface: `commerce-web/apps/onboarding-ops/`
- Local dependencies only: `commerce-ops/onboarding/`

Payment, DNS changes, approved theme releases, staff operations, and store
provisioning are separate capabilities. Do not treat local API setup as a
production customer onboarding runbook.
