# Backend documentation

This folder owns the Rust gateway, domain crates, persistence and commerce API documentation. [Frontend](../frontend/README.md), [admin UI](../admin-ui/README.md) and [AI service](../ai-service/README.md) have separate guides.

| Guide | Subject |
| --- | --- |
| [Architecture and crate map](architecture.md) | Ownership, gateway composition and source map |
| [Development and checks](development.md) | Local startup, configuration and focused validation |
| [API contracts](api.md) | Generated OpenAPI, identity, request protection and client regeneration |
| [API inventory and access](api-inventory.md) | Complete route coverage, public/merchant/internal references and reviewed exceptions |
| [Data and integrations](data-and-integrations.md) | Migrations, transactions, outbox, search, reporting, media and notifications |
| [Marketing notifications](marketing-notifications.md) | Journey rules, dynamic templates, durable generation and future delivery boundaries |
| [Engagement isolation](engagement-isolation.md) | Tenant and customer boundaries for engagement data |
| [Mobile experience](mobile-experience.md) | Native mobile contracts, App Studio drafts, publication and build queue foundation |
| [Commerce domains](domains.md) | Cart/orders, support, segments and admin operations |
| [Catalog and markets](catalog-and-markets.md) | Categories, attributes, translations, market publication and quote invalidation |
| [Fulfillment](fulfillment.md) | Store/branch capabilities, scheduling and reservations |
| [Public publication](publication.md) | Installation binding, public facts, indexing, feeds and live acceptance |

These guides describe repository behavior. Verify the target installation and release evidence before relying on a production capability.
