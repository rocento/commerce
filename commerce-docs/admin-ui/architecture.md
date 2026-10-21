# Admin architecture and access

[main.tsx](../../commerce-web/apps/admin/src/main.tsx) owns authenticated shell composition, identity admission, navigation, permission-gated routes and the merchant assistant drawer. [route-pages.ts](../../commerce-web/apps/admin/src/route-pages.ts) exposes lazy page components. [configuration.tsx](../../commerce-web/apps/admin/src/configuration.tsx) owns the System → Configuration workspace, using a shared section registry for permission-filtered navigation and route admission. Page modules own their forms, query state and validations; shared API helpers live in `commerce-web/packages/api-client` and shared controls in `commerce-web/packages/ui`.

Admin uses React 18, React Router and TanStack Query. Default shell queries disable automatic retry and refetch-on-focus. Errors and retry controls must be meaningful for the operation rather than silently repeating writes.

`AdminIdentity.permissions` controls route access and write controls, with `*` super-admin support. Read and write permissions are distinct. The gateway independently checks the authenticated admin session and request protection; a hidden link or read-only component is not the security boundary. Keep endpoint authorization even when adding a new navigation shortcut.

| Route family | UI owner / boundary |
| --- | --- |
| `/catalog/*` | Products, categories, attributes, inventory, sources and stock |
| `/sales/*` | Orders and geography; legacy customer/support links redirect |
| `/customers/*` | Profiles, attributes, segments and journey |
| `/support/*` | Tickets and guide |
| `/marketing/*` | Promotions, journey-based notification programs, storefront inbox publication and review moderation |
| `/content/*` | Pages, navigation, theme editing, channel assignments and storefront languages |
| `/system/configuration/*` | Industry, markets, fulfillment policies, delivery fee, tax, capacity activation and assistant |
| `/system/configuration/discoverability/*` | Business profile, publication metadata, indexing policy, crawler access and visibility diagnostics |
| `/system/{users,roles,audit}` | Security menu: Admin users, Roles & permissions and Audit log; existing URLs and individual permissions are preserved |
| `/system/{import,export}` | System menu: data transfer |
| `/fulfillment/*` | Schedules, capacity rules and replenishment |
| `/settings/*`, `/discoverability/*` | Legacy links redirect to their canonical Configuration sections (or Content for storefront languages), preserving query strings and fragments |
| `/system/configuration/languages` | Redirects to `/content/languages`, preserving query strings and fragments |
| `/system/configuration/channel-assignments` | Redirects to `/content/theme-assignments`, preserving query strings and fragments |
| `/reports/*` | Dashboard, cohorts and AI usage |

Configuration sections keep their API-defined scopes and individual save or publication controls. Read access is distinct from editing and publication; channel assignments retain channel-specific theme grants. Operational schedules, capacity rules, inventory entities and content editors remain outside Configuration. See [content and store settings](content-and-settings.md) for section scopes.

Reuse [PageHeader](../../commerce-web/apps/admin/src/page-header.tsx), grids, row actions, notices and existing unsaved-change handling. Deep links, direct reloads, browser back and narrow layouts should work with permission and error states. Place new behavior in its domain page rather than expanding the shell with unrelated business rules.
