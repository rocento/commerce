# Frontend documentation

This is the documentation home for the customer storefront, corporate website and shared frontend packages. The merchant admin application has its own [admin UI guides](../admin-ui/README.md); commerce APIs are documented in [backend guides](../backend/README.md).

| Guide | Subject |
| --- | --- |
| [Architecture and source map](architecture.md) | Apps, shared packages and ownership |
| [Development and checks](development.md) | Installation, startup, builds and testing |
| [Storefront flows](storefront.md) | Shopping, cart, checkout, account, delivery and assistant |
| [Themes, language and markets](themes-and-localization.md) | Presentation, preview, translation and published prices |
| [Public storefront publication](publication.md) | SSR, canonical URLs, status codes, indexing and release checks |
| [Corporate website](website.md) | Static export, content loader and deployment |
| [Assets and demo data](assets-and-demos.md) | Fonts, licenses, delivery directory and demo boundaries |

Mobile storefronts, App Studio and native preview have their own [mobile documentation](../mobile/README.md). The [local 60 FPS native preview benchmark](history/local-preview-60fps-2026-10-14.md) records a separate capture and transport experiment.

## Storefront notification inbox

The header bell opens a persistent native inbox for guests and customers, with unread count, All/Unread filters, explicit read controls, mark-all and pagination. Marketing publishes announcements and reviewed customer journey records through its Notifications workspace. Guests receive general announcements; personal snapshots are visible only to their authenticated customer. Public HTML renders a neutral bell and loads the inbox after session restoration in the browser. See [notification architecture and deployment](../backend/marketing-notifications.md) for permissions, publication rules and tests.

These guides describe repository behavior. Verify the target installation and release evidence before relying on a production capability.
