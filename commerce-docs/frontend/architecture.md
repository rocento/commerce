# Frontend architecture and source map

The [frontend pnpm workspace](../../commerce-web/pnpm-workspace.yaml) contains the storefront, admin, App Studio and rengine applications. App Studio and the corporate website keep separate hosts and runtime entry points; rengine also remains a standalone Node service. Keep those runtime boundaries when changing shared components or dependencies.

| Owner | Source | Responsibility |
| --- | --- | --- |
| Storefront | `commerce-web/apps/storefront` | Customer shopping application and public publication renderer |
| Admin | `commerce-web/apps/admin` | Authenticated merchant operations; [admin docs](../admin-ui/README.md) |
| Website | `commerce-corporate-site` | Corporate pages and static knowledge articles |
| App Studio | `commerce-web/apps/mobile-studio` | Mobile configuration authoring and browser/native preview; [mobile docs](../mobile/README.md) |
| rengine | `commerce-web/apps/rengine` | Assistant diagnostics service and browser UI; [rengine docs](../rengine/README.md) |
| API client | `commerce-web/packages/api-client` | Typed HTTP helpers, validation, generated schema and assistant stream contracts |
| Shared UI | `commerce-web/packages/ui` | Components, fonts, styles and action helpers |
| Shared config | `commerce-web/packages/config` | Common TypeScript configuration |

The browser uses `/api` through Vite or ingress. Development proxies strip `/api` before forwarding to Rust at port 8080. Rust owns permissions, prices, inventory, quotes and mutation receipts. UI state and hidden buttons cannot grant authority.

## Storefront source map

| Change | Start in `commerce-web/apps/storefront` |
| --- | --- |
| App composition and routes | `src/main.tsx` |
| Catalog and search | `src/catalog.tsx`, `src/search.tsx`, `src/browse-category.ts` |
| Cart and quote review | `src/cart.tsx`, `src/checkout.tsx`, `src/checkout-logic.ts` |
| Delivery and addresses | `src/locations.tsx`, `src/delivery-geography.ts`, `src/fulfillment-selection.ts` |
| Orders and support | `src/orders.tsx`, `src/support.tsx` |
| Assistant composition | `src/assistant.tsx` |
| Assistant response lifecycle and panels | `src/assistant-stream.ts`, `src/assistant-panels.tsx`, `src/assistant-chrome.tsx` |
| Assistant support intake | `src/assistant-ticket-flow.ts` |
| Assistant rich blocks | `src/assistant-rich.tsx`, focused `src/assistant-*` modules |
| Comparison | `src/comparison.tsx`, `src/comparison-model.ts` |
| Theme rendering and tokens | `src/themes.tsx`, `src/theme-sections.tsx`, `src/theme-tokens.ts`; category availability uses the shared API client in `packages/api-client/src/catalog.ts` |
| Interface language | `src/interface-locale.tsx`, `src/interface-messages.json`, `src/shopper-locale.ts` |
| Public rendering | `src/entry-public-server.tsx`, `src/public/`, `server/publication.mjs` |
| Build compression and warmup | `build-compression.ts`, `build-warmup.ts` |

Use the public shared API-client exports rather than new ad hoc fetch wrappers. Contract changes should start in the owning backend source, regenerate OpenAPI/types as needed, and update both callers and validation. [Backend API contracts](../backend/api.md) explains that workflow.

Shared `packages/ui/src/styles.css` imports `base.css` for browser defaults and typography, then `forms.css` for controls and feedback. Keep that order when changing the common cascade. Application-specific styles remain in each app.
