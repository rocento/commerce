# Content and store settings

## System configuration

System → Configuration (`/system/configuration`) is the central workspace for platform settings. Its left sidebar groups configuration sections, and each section retains its own permissions, validation and save or publication actions. Existing settings and discoverability URLs redirect to their corresponding configuration sections so saved links continue to work.

Configuration does not add a new store hierarchy or a universal scope selector. Each section uses the scope already enforced by its API:

| Section | Route under `/system/configuration` | Scope and application |
| --- | --- | --- |
| Markets | `/markets` | Draft market overrides; an explicit reviewed publication changes the installation's single live market. |
| Industry profile | `/industry` | Catalog profile and attribute templates for this store, plus the store's discovery-ranking control. Applying a profile preserves existing product values. |
| Delivery & pickup | `/fulfillment` | Selected store's policy overrides and connected pickup locations. This section shows actual inherited defaults and resolved values; saving changes the active store policy. |
| Delivery fee | `/delivery-fee` | One installation-wide flat fee for new checkout reviews. Existing orders retain their original fee. |
| Tax rules | `/tax` | Geographic rules used at checkout. The highest-priority matching active rule applies; previous orders retain their tax. |
| Capacity controls | `/capacity` | Legacy installation-wide checkout admission activation, where supported. Current installations use their per-store fulfillment policy. |
| Shopping Assistance | `/ai-assistant` | Storefront assistant enablement, provider model and server-stored credentials. Saved changes apply to new requests. |
| Search & AI visibility | `/discoverability/{overview,seo,ai,profile,performance}` | Store identity, canonical/indexing preferences, search appearance, crawler preferences, approved business information and visibility diagnostics. Effective publication still depends on server policy. |

Permission-filtered navigation does not grant access to another section. Read-only roles can inspect their permitted settings while existing write, publication and channel-specific checks remain enforced. Save buttons apply only to their owning forms; there is no cross-section bulk save.

Admin users, Roles & permissions and Audit log are grouped under Security, retaining their existing `/system/` URLs and individual permissions. Data transfer remains under System. Catalog entities, inventory locations, stock pools, delivery areas, schedules and capacity operations, per-product replenishment policies, themes and content stay in their operational workspaces.

## Transactional email templates

Marketing → Email templates (`/marketing/email-templates`) manages the installation's registration verification, password reset, order confirmation and shipment notification emails. Search the template library, edit the subject, heading and message, and preview HTML or plain text with synthetic sample data. Account templates also have an editable action label; the server supplies the actual verification or reset URL and a protected expiry/single-use security notice. Template content accepts the listed `{{variable}}` placeholders and is escaped when rendered as HTML. Unknown variables, missing required expiry/order/shipment details and excessive placeholder repetition are rejected. `brand_name` uses the installation's configured site name; Arabic message text supports automatic reading direction.

The workspace has separate Content, Preview and Version history tabs. Content provides the editor and variable guide; Preview shows the complete email with desktop/mobile widths, HTML/plain text, and draft/live controls. Moving between tabs keeps unsaved edits. Arrow keys and Home/End navigate the tabs. Preview requests run when the Preview tab is opened.

Save draft records a change reason without changing customer emails. Review & publish opens the saved draft in Preview; publication requires a successful preview of that exact revision and content. Unsaved changes must first be saved or discarded. A stale revision rejects the operation so one administrator cannot silently overwrite another's work. Reload latest version loads another editor's saved draft, with confirmation before discarding local edits. Version history shows the publisher, publication time and reason. Restoring a version returns it to the draft for editing and review; publish again to activate it.

Default emails use a branded header, a short inbox preview line, a purpose-specific heading, and a footer. Order and shipment details appear in a dedicated summary card. Account emails include an action button, a copyable fallback URL and a security notice. The layout uses presentation tables and inline styles, supports narrow screens and introduces no remote assets or tracking pixels. Custom saved and published wording remains intact when the built-in copy changes; newly rendered emails use the shared layout, while queued retries retain their existing snapshot.

Roles use `email_templates.read` for templates, history and previews, `email_templates.write` for saving/restoring drafts, and `email_templates.publish` for publication. Editing and publishing also require read access. Super administrators retain wildcard access; existing restricted roles must be granted these permissions explicitly. Save, publish and restore actions appear in the audit log.

Published content applies to messages when the delivery worker first prepares them. Once prepared, retries retain their rendered subject, HTML and plain text. Until the first custom publication, built-in content remains active. These templates are installation-wide; the feature does not introduce per-language or per-channel variants. Previewing sends no email. Delivery provider configuration remains in the existing deployment settings, and publication does not prove inbox delivery. See [notification behavior](../backend/data-and-integrations.md#notifications).

## Themes and navigation

Content → Themes edits revisioned drafts; publishing appends an immutable snapshot. Saves reject stale revisions. Content → Channel assignments (`/content/theme-assignments`) selects default and targeted published themes. The former `/system/configuration/channel-assignments` URL redirects here, preserving query strings and fragments. Assignments have independent guards, and publication requires access to every assigned channel. Rollback publishes a historical configuration as a new version while retaining the draft.

Permissions include `theme.read`, `theme.create`, `theme.edit`, `theme.preview`, `theme.publish`, `theme.rollback` and `theme.assign`, with channel-scoped forms such as `theme.edit@storefront`. The channel assignments route accepts global or channel-scoped `theme.read`; the API returns only assignments for readable channels. Saving additionally requires `theme.assign` for the destination channel and each selected theme's owner channel. Theme preview requires the existing admin session; its UUID is not a credential.

Section controls manage product/category sources, content, media/alt text, destinations and display. Category IDs remain IDs; changing a source does not reassign products. Optional sections have new identities when duplicated, required slots stay protected and the layout is limited to 30 sections. Media references and configured tokens are validated server-side. Navigation and CMS pages retain draft/publish permissions.

## Language and market preparation

Content → Storefront languages (`/content/languages`) prepares draft locales and catalog translations reviewed against source snapshots. Missing, draft, reviewed and source-changed states remain explicit. This does not publish a second catalog content locale. The separate Shopping interface tab edits English/Arabic plural forms, previews plain text and supports UTF-8 BOM CSV export/import under `languages.read`/`languages.write`. Draft saved edits and published shopper messages have different scopes. The former `/system/configuration/languages` and `/settings/languages` URLs redirect here, preserving query strings and fragments.

System → Configuration → Markets (`/system/configuration/markets`) prepares draft overrides, runs readiness, previews effective prices and publishes one market per installation after explicit review/reason. Publication requires `markets.publish`, `catalog.write` and `cms.publish`; stale reviewed fingerprints fail. Draft edits do not change an existing release. Restore defaults removes the active overlay while retaining release/order history. [Backend market guide](../backend/catalog-and-markets.md) explains limitations and revalidation.

## Discoverability and assistant

System → Configuration → Search & AI visibility (`/system/configuration/discoverability/overview`) owns merchant metadata, canonical binding, effective indexing, feed controls and health. Show the server-computed effective result: a saved toggle is not proof of a public indexable response. Draft/private resources must not appear in public snapshots, feeds or sitemaps. [Publication rules](../backend/publication.md) cover host identity and deployment safeguards.

System → Configuration → Shopping Assistance (`/system/configuration/ai-assistant`) uses `assistant.settings.read` and `.write`, scoped provider tests and readiness probes. Never display returned secret material. Reports distinguish usage, conversation state and evidence-backed completion. The Ask Commerce AI drawer sends authenticated bounded merchant queries; it does not grant a general model control surface. Customer AI runtime and its interpretation rules live in [AI service docs](../ai-service/README.md).
