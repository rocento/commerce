export type DocSection = {
  id: string;
  title: string;
  paragraphs?: string[];
  bullets?: string[];
  steps?: string[];
  note?: string;
  table?: { headers: string[]; rows: string[][] };
};

export type DocArticle = {
  slug: string;
  title: string;
  summary: string;
  category: string;
  audience: string;
  updated?: string;
  sections: DocSection[];
  related: string[];
};

// Product behavior is grounded in the current admin, storefront and gateway
// implementations, and the source-owned guides in commerce-docs. Environment
// configuration and role permissions determine which capabilities are available.
export const docArticles: DocArticle[] = [
  {
    slug: "getting-started",
    title: "Getting started with Rocento",
    summary: "Set up your store and verify a complete purchase.",
    category: "Start here",
    audience: "Store owners · Implementation teams",
    sections: [
      {
        id: "before-you-start", title: "Before you start",
        paragraphs: ["Have an administrator account, sample products, a store country and currency, and a delivery or pickup plan."],
        bullets: ["Prepare SKUs, prices, categories, images and quantities.","Identify stock locations and the default pool.","Prepare branding, customer policies, delivery fees and tax settings."],
        note: "Navigation varies by installed version. These guides use System → Configuration. Older workspaces may list the same settings directly in the sidebar. Each screen retains its own save and publication controls.",
      },
      {
        id: "setup-sequence", title: "Set up in dependency order",
        steps: ["Review industry, country, currency and fulfillment defaults in System → Configuration.","Create categories and a representative product in Catalog.","Connect locations to stock pools and add product quantities.","Configure coverage, pickup, schedules and capacity.","Preview and publish themes, navigation and content; assign a published theme.","Review checkout charges and visibility. Check assistant readiness before enabling it."],
      },
      {
        id: "first-journey", title: "Verify the first customer journey",
        steps: ["Find an active, available product and add it to the cart.","Select an eligible address or pickup location.","Review amounts and timing, then place a test order.","Find the order in Sales → Orders; verify inventory and capacity."],
        note: "Confirm the saved order and its operational effects before launch.",
      }
    ],
    related: ["platform-overview","catalog","inventory","fulfillment","deployment"],
  },
  {
    slug: "platform-overview",
    title: "Platform overview",
    summary: "See how the platform connects commerce and operations.",
    category: "Start here",
    audience: "Business leaders · Product teams · Administrators",
    sections: [
      {
        id: "connected-platform", title: "One connected commerce operation",
        paragraphs: ["Rocento connects the storefront, merchant workspace and commerce backend. The backend validates identity, prices, availability and orders.","Industry profiles supply product attributes. Merchants configure their own catalog, stock, content and themes."],
      },
      {
        id: "capabilities", title: "Capability map",
        table: {"headers":["Area","Capabilities"],"rows":[["Catalog","Products, categories, attributes and media."],["Commerce","Cart, checkout, orders, promotions and tax."],["Operations","Stock, coverage, pickup, schedules and capacity."],["Customers","Profiles, segments, journeys and support."],["Storefront","Themes, navigation, pages, languages and markets."],["Intelligence","Reporting, shopping assistance and diagnostics."],["Administration","Users, permissions, audit and publication."]]},
      },
      {
        id: "operating-model", title: "How changes become customer experiences",
        bullets: ["Settings have distinct store, channel or installation scopes.","Saving a theme or market draft does not publish it.","Checkout uses current facts; search and reports update asynchronously.","Assistant actions require enabled capabilities and authoritative outcomes."],
      },
      {
        id: "choose-your-path", title: "Choose your documentation path",
        bullets: ["Operators: catalog, inventory, fulfillment and orders.","Experience teams: storefront, languages and discoverability.","Administrators: access, data transfer and security.","Developers: architecture, API and deployment."],
        note: "Available actions depend on your role and installation configuration.",
      }
    ],
    related: ["getting-started","administration","architecture","ai-assistant"],
  },
  {
    slug: "catalog",
    title: "Catalog and product data",
    summary: "Manage products, categories, attributes and media.",
    category: "Commerce",
    audience: "Catalog managers · Merchandising teams",
    sections: [
      {
        id: "catalog-model", title: "Understand the product record",
        paragraphs: ["Products combine SKU, name, price, currency and status with categories, media and typed attributes. Attribute sets group fields; industry profiles supply starting definitions while preserving existing values."],
      },
      {
        id: "create-product", title: "Create and verify a product",
        steps: ["Open Catalog → Products. Enter SKU, name, selling unit, price and currency.","Choose primary/additional categories and an attribute set.","Complete required attributes and attach media.","Save, activate and supply inventory.","Verify product details, browsing and search. Check effective prices if a market release is active."],
      },
      {
        id: "categories", title: "Primary and additional categories",
        paragraphs: ["The primary category drives existing policies and breadcrumbs. Additional categories expand discovery. Each product supports up to 50 direct assignments, including primary.","Search reflects category changes after indexing completes."],
      },
      {
        id: "catalog-quality", title: "Maintain trustworthy product facts",
        bullets: ["Verify enrichment suggestions before accepting them.","Translation edits share product identity and inventory.","For missing products, check status, stock, categories, market assortment and indexing.","Validate bulk changes using the correct import template."],
        note: "Missing product facts remain unknown. Do not infer specifications or allergens from names.",
      }
    ],
    related: ["inventory","import-export","languages-markets","entity-identifiers"],
  },
  {
    slug: "inventory",
    title: "Inventory and stock pools",
    summary: "Connect locations, stock pools and available quantities.",
    category: "Operations",
    audience: "Inventory managers · Operations teams",
    sections: [
      {
        id: "inventory-concepts", title: "Locations, pools and availability",
        table: {"headers":["Concept","Meaning"],"rows":[["Location / source","Physical warehouse or branch."],["Stock pool","Grouped sources with deduction priorities."],["On-hand","Recorded source quantity."],["Available","Eligible stock minus live reservations."],["Default stock","Default storefront/cart pool."],["Global stock","Availability visible beyond local service areas."]]},
      },
      {
        id: "configure-stock", title: "Configure the inventory chain",
        steps: ["Create and enable a location in Inventory → Locations.","Create a stock pool and assign sources.","Set priorities: lower numbers deduct first.","Choose default/global behavior and save.","Add product quantities; inspect reservations and availability.","Test a cart with the intended delivery or pickup context."],
      },
      {
        id: "global-stock", title: "Global stock and delivery are separate controls",
        paragraphs: ["Global stock appears across browsing locations, including uncovered pins. It does not enable worldwide delivery; local checkout still requires eligible coverage and sources.","Global delivery separately allows eligible default/global sources. Inventory, schedules and capacity still apply. Shared sources count once in availability."],
      },
      {
        id: "replenishment", title: "Use replenishment recommendations",
        paragraphs: ["Inventory → Replenishment uses stock, sales velocity and saved policies. Set supplier, lead time, target cover, safety stock, minimum quantity and order multiple. Save to recalculate recommendations."],
        note: "For blocked checkout, check available stock, enabled sources, pool assignments, coverage and capacity.",
      }
    ],
    related: ["delivery","fulfillment","catalog","checkout-orders"],
  },
  {
    slug: "delivery",
    title: "Delivery coverage and pickup",
    summary: "Configure coverage and eligible pickup locations.",
    category: "Operations",
    audience: "Operations teams · Store administrators",
    sections: [
      {
        id: "coverage-model", title: "Choose the store's coverage policy",
        paragraphs: ["In System → Configuration → Delivery & pickup, select the store and enable delivery. Review inherited defaults and overrides."],
        table: {"headers":["Mode","Eligibility"],"rows":[["Map boundaries","Active service areas and eligible stock."],["City restrictions","Configured city IDs; boundaries disabled."],["Unrestricted saved addresses","No boundaries or city restrictions; default stock."],["Global delivery","Worldwide addresses; eligible default/global stock."]]},
      },
      {
        id: "local-delivery", title: "Configure local delivery",
        steps: ["Enable delivery and choose boundaries or city restrictions.","For boundaries, activate service areas and assign stock pools.","Check source inventory, routing, schedules and capacity.","Save with a reason; test covered and uncovered addresses."],
      },
      {
        id: "global-delivery", title: "Enable global delivery deliberately",
        paragraphs: ["Enable Global delivery coverage to bypass saved area/city restrictions. Turning it off restores those rules.","Global stock visibility alone does not authorize delivery. Global coverage still checks stock, routing, schedules, capacity and checkout charges; it does not create market currencies or country-specific policies."],
      },
      {
        id: "pickup", title: "Offer pickup from a connected location",
        bullets: ["Enable pickup at the store and connected location.","Set instructions, preparation time and stock.","Configure pickup calendars separately from delivery.","Test checkout with an explicit pickup location."],
        note: "Saved policy changes apply immediately and invalidate open checkout selections.",
      }
    ],
    related: ["fulfillment","inventory","checkout-orders","administration"],
  },
  {
    slug: "checkout-orders",
    title: "Checkout and order operations",
    summary: "Review checkout and manage confirmed orders.",
    category: "Operations",
    audience: "Order operations · Customer service · Integrators",
    sections: [
      {
        id: "review-and-placement", title: "Review before committing an order",
        paragraphs: ["Checkout validates the basket, availability, prices, discounts, fulfillment, tax and delivery fee.","Cart, policy, market or reservation changes can require a fresh review. The saved order and placement response establish success."],
      },
      {
        id: "operator-workflow", title: "Work an order through operations",
        steps: ["Find the order in Sales → Orders using supported references or filters.","Review customer, items, amounts and fulfillment details.","Use actions allowed by the current state and your permissions.","Record required notes and verify the refreshed order.","Use support tickets for customer follow-up."],
      },
      {
        id: "money-and-history", title: "Interpret recorded amounts correctly",
        bullets: ["Orders retain their original commercial facts after settings or promotion changes.","Compare subtotal, discount, delivery and tax components.","Use the order number when the customer workflow expects it; Entity ID is separate.","Sales reports measure booked value, not cash collected."],
      },
      {
        id: "uncertain-outcomes", title: "Resolve uncertain checkout outcomes",
        paragraphs: ["After a placement timeout, inspect order history before another purchase. Integrations retry the same operation using its original idempotency key.","Refresh stale quotes. Assistant checkout handoffs open review; conversational wording alone does not place an order."],
      }
    ],
    related: ["fulfillment","promotions","support","api","analytics"],
  },
  {
    slug: "customers",
    title: "Customers, segments and journeys",
    summary: "Inspect profiles, audience counts and recorded journeys.",
    category: "Commerce",
    audience: "Customer operations · Marketing analysts",
    sections: [
      {
        id: "customer-record", title: "Use the customer profile",
        paragraphs: ["Customer → Profiles shows account details, verification, group, attributes and saved addresses. Open Shopping journey for recorded activity.","When investigating delivery, distinguish an entrance pin from approximate area coordinates."],
      },
      {
        id: "segments", title: "Create a segment from supported fields",
        steps: ["Open Customer → Segments and add a named definition.","Choose all/any conditions and supported fields.","Save, then inspect membership count and evaluation time.","Refresh counts when current membership matters."],
        note: "Segments provide definitions and counts. Promotion/content targeting and membership export are not connected. Active/inactive does not change the count.",
      },
      {
        id: "segment-semantics", title: "Read counts accurately",
        bullets: ["Segments overlap; do not sum counts as unique customers.","Order rules use delivered or cash-collected orders.","Cart rules include saved lines with expired reservations.","Missing values never match; custom scalar fields use exact text.","Address, anonymous-visitor, browsing, newsletter and store-credit rules are unsupported."],
      },
      {
        id: "journey", title: "Investigate a shopping journey",
        paragraphs: ["Choose a period, inspect event timestamps and export displayed events when authorized. Only activity linked to that customer appears; an empty range means no matching events were recorded."],
      }
    ],
    related: ["analytics","support","administration","security"],
  },
  {
    slug: "promotions",
    title: "Promotions and coupons",
    summary: "Create offers and verify discount behavior.",
    category: "Commerce",
    audience: "Merchandising teams · Store administrators",
    sections: [
      {
        id: "discount-model", title: "Understand how offers are selected",
        paragraphs: ["One catalog discount applies per item, followed by one cart discount. Higher priority wins; ties use rule ID. An entered coupon replaces automatic cart offers. Discounts apply before tax."],
      },
      {
        id: "create-offer", title: "Create an offer",
        steps: ["Open Marketing → Promotions → Add promotion.","Choose catalog/cart scope, discount kind and value.","Set supported SKU, category, customer-group or attribute conditions.","Configure minimum subtotal and coupon where supported.","Set priority, activation and dates; end must follow start.","Save and test eligible and ineligible baskets."],
      },
      {
        id: "validate-offer", title: "Verify combinations and edge cases",
        bullets: ["Test competing priorities and coupon/no-coupon behavior.","Check subtotal boundaries and excluded products or groups.","Review the final total with delivery and tax.","Check activation timestamps in your admin environment."],
      },
      {
        id: "change-offer", title: "Change or retire a promotion",
        paragraphs: ["Edits and deletion affect future use; existing orders retain recorded discounts. Verify changes with a new checkout review.","If a discount is missing, check status, dates, scope, eligibility, subtotal, competing rules and entered coupons."],
      }
    ],
    related: ["checkout-orders","catalog","customers","analytics"],
  },
  {
    slug: "storefront",
    title: "Storefront themes and content",
    summary: "Preview, publish and assign themes and content.",
    category: "Storefront",
    audience: "Experience teams · Content editors · Administrators",
    sections: [
      {
        id: "publishing-model", title: "Drafts, versions and assignments",
        paragraphs: ["Content → Themes manages drafts. Publishing creates an immutable version; channel assignments select published versions.","Saving, publishing and assignment are separate actions. Navigation and CMS pages use their own publication workflows."],
      },
      {
        id: "theme-workflow", title: "Publish a theme change",
        steps: ["Open the intended theme and confirm its channel/revision.","Edit sections, sources, media, text and destinations.","Preview desktop and narrow layouts with your admin session.","Save; reload and reconcile any stale-revision conflict.","Publish, then review Content → Channel assignments.","Verify the live channel and targeting context."],
      },
      {
        id: "section-rules", title: "Work within section rules",
        bullets: ["Layouts allow 30 sections; required slots stay protected.","Duplicated optional sections receive new identities.","Section category selections do not recategorize products.","Server validation checks media references and tokens.","Preview requires admin authentication and prevents order placement."],
      },
      {
        id: "rollback", title: "Recover a previous design",
        paragraphs: ["Rollback publishes a historical configuration as a new version and retains the draft. Verify the resulting version and assignments.","For missing changes, check publication, assignment and targeting before editing again."],
        note: "Edit, preview, publish, rollback and assign permissions are separate and can be channel-scoped.",
      }
    ],
    related: ["languages-markets","discoverability","administration","catalog"],
  },
  {
    slug: "languages-markets",
    title: "Languages and market publication",
    summary: "Manage interface copy, translation drafts and market releases.",
    category: "Storefront",
    audience: "Localization teams · Merchandising teams",
    sections: [
      {
        id: "three-scopes", title: "Understand the three scopes",
        paragraphs: ["Product identity and inventory remain shared. Draft locales do not publish a second content locale."],
        table: {"headers":["Workflow","Scope"],"rows":[["Shopping interface","English/Arabic messages and plural forms."],["Catalog translations","Text drafts, source snapshots and review states."],["Market release","One live country/currency and assortment/price overlay."]]},
      },
      {
        id: "translations", title: "Prepare and review translations",
        steps: ["Open Content → Storefront languages.","Edit catalog text against its source and review its state.","Preserve interface placeholders and plural forms; preview or use CSV.","Save/publish through the relevant workflow and verify shopper output."],
        note: "Source-text changes can invalidate review. Incompatible interface overrides fall back to current source text.",
      },
      {
        id: "market-publication", title: "Publish a reviewed market",
        steps: ["Prepare assortment and prices in Configuration → Markets.","Run readiness; resolve currency, language, price and product issues.","Preview effective facts, then publish the reviewed revision with a reason.","Verify storefront and checkout; stale carts/proposals need review."],
      },
      {
        id: "market-boundaries", title: "Operate the published release",
        paragraphs: ["Draft edits do not change a release or activate source-inactive products. Restore defaults retains release/order history.","Each installation has one live market, without simultaneous country switching or separate per-market payment, delivery and tax policies."],
      }
    ],
    related: ["catalog","storefront","checkout-orders","discoverability"],
  },
  {
    slug: "discoverability",
    title: "Search and AI visibility",
    summary: "Manage public identity, indexing and publication health.",
    category: "Storefront",
    audience: "Content teams · Growth teams · Platform operators",
    sections: [
      {
        id: "public-facts", title: "Publish consistent public information",
        paragraphs: ["Configuration → Search & AI visibility manages identity, search appearance, crawler preferences, approved business facts and diagnostics.","Public documents use active/published records and effective market facts. Private drafts are excluded."],
      },
      {
        id: "configure-visibility", title: "Review visibility settings",
        steps: ["Confirm the approved HTTPS origin and merchant identity.","Review business information and search appearance.","Inspect effective indexing and deployment protection.","Check live product, category and content pages.","Review feed freshness and publication errors."],
      },
      {
        id: "effective-indexing", title: "Use the effective result",
        paragraphs: ["Effective indexing combines merchant preference, approved domain, environment and deployment protections. A saved toggle alone does not establish indexability.","Demo, staging and admin protections remain separate. Robots/noindex do not protect private data."],
      },
      {
        id: "feeds-and-diagnostics", title: "Monitor publication changes",
        bullets: ["Check completion and freshness of asynchronous indexing/feed jobs.","Verify public behavior and feed withdrawal after removing products.","Investigate unavailable pages through publication, market assortment and canonical-host settings.","Keep media and structured facts consistent with the storefront."],
        note: "Published feeds and structured data do not guarantee indexing, rankings, rich results or AI citations.",
      }
    ],
    related: ["storefront","catalog","languages-markets","deployment"],
  },
  {
    slug: "analytics",
    title: "Analytics and reporting",
    summary: "Read metrics with their scope and freshness.",
    category: "Intelligence",
    audience: "Business analysts · Store owners · Operations teams",
    sections: [
      {
        id: "report-workflow", title: "Start with scope and freshness",
        steps: ["Open Sales dashboard or Cohort & retention.","Select UTC dates and inspect Data through.","Review currencies separately and check delay notices.","Reconcile daily figures with orders; refresh after reporting completes."],
      },
      {
        id: "metric-definitions", title: "Understand the core measures",
        table: {"headers":["Measure","Definition"],"rows":[["Net booked value","Order-date totals with tax/delivery; excludes cancelled/failed deliveries. Refunds reduce original dates."],["Shopping funnel","Ordered browser events within one session and UTC day."],["Traffic","First tracked visit per session/UTC day."],["Top products","Discounted merchandise; excludes cancelled, failed and fully refunded orders."],["Retention","Repeat buying by first-valid-order cohort."],["Lifetime value","Lifetime net booked value by customer cohort and currency."]]},
      },
      {
        id: "interpretation", title: "Avoid misleading comparisons",
        bullets: ["Booked value is not cash collected.","Blocked tracking and cross-day journeys limit funnel coverage.","Future cohort months are unobserved, not zero.","Check timestamps before treating reports as current."],
      },
      {
        id: "assistant-reporting", title: "Read assistant outcomes separately",
        paragraphs: ["Assistant reports show recent outcomes and recorded latency. Completion does not establish answer quality or purchase success.","Authorized Assistant tracking provides request-ID and outcome investigations. Tracking exports require separate permission."],
      }
    ],
    related: ["customers","checkout-orders","ai-assistant","administration"],
  },
  {
    slug: "ai-assistant",
    title: "Shopping assistance",
    summary: "Provide grounded product help and enabled commerce actions.",
    category: "Intelligence",
    audience: "Store owners · Customer experience teams · Operators",
    sections: [
      {
        id: "assistant-capabilities", title: "What the assistant can help with",
        paragraphs: ["The assistant uses supported language interpretation, current commerce facts and approved knowledge. Enabled capabilities determine each response."],
        table: {"headers":["Journey","Behavior"],"rows":[["Discovery","Search, constrained recommendations, comparisons and facts."],["Cart/wishlist","Scoped reads and enabled add/remove/quantity/transfer actions."],["Orders/support","Owned information and validated support forms."],["Checkout","Review and checkout handoff."],["Delivery","Address information and selection guidance."]]},
      },
      {
        id: "enable-assistant", title: "Configure and validate assistance",
        steps: ["Open Configuration → Shopping Assistance.","Review enablement, provider and model; save credentials through the supported form.","Run provider/readiness checks.","Test representative reads and enabled actions.","Verify resulting records; investigate with request IDs."],
      },
      {
        id: "action-boundaries", title: "Understand action boundaries",
        bullets: ["Actions require identity, permissions, explicit product selection and current facts.","Unknown product facts remain unknown.","Chat wording alone never places an order.","Compound cart/wishlist execution requires separate gates, persistence and receipts.","Merchant queries retain operator permissions."],
      },
      {
        id: "diagnostics", title: "Investigate an assistant issue",
        paragraphs: ["Check request ID, intended product, readiness and customer context. Confirm the operational result; a completed stream is insufficient."],
        note: "Restrict tracking exports: redacted diagnostics may still contain customer text.",
      }
    ],
    related: ["catalog","checkout-orders","analytics","security","architecture"],
  },
  {
    slug: "import-export",
    title: "Data imports and exports",
    summary: "Validate bulk changes and export operational data.",
    category: "Administration",
    audience: "Data managers · Administrators · Integration teams",
    sections: [
      {
        id: "prepare-import", title: "Prepare an import from its template",
        paragraphs: ["System → Data transfer · Import supports Products and Inventory quantities. Products create/update by SKU; inventory adjusts existing SKUs.","Use exact template headers and UTF-8. Imports allow 500 rows/2 MB per batch with all-or-nothing writes. Report exports may need column mapping."],
      },
      {
        id: "import-workflow", title: "Validate, review and apply",
        steps: ["Download the current template and keep the source file.","Populate required fields and select the file.","Enter a change reason where required.","Validate; review changes and correct every error.","Apply, then verify results and representative records."],
        note: "Replacing input clears its preview. Apply revalidates current database state, so an earlier preview can become stale.",
      },
      {
        id: "exports", title: "Export the data you intend to use",
        paragraphs: ["Choose supported filters and columns. Background CSV/XLSX exports use stable snapshots; downloads require authorization.","CSV protects formula-like text reversibly; XLSX values are strings. Preserve protection during spreadsheet transformations."],
      },
      {
        id: "recovery", title: "Recover from errors and uncertainty",
        bullets: ["Correct rejected rows while retaining source evidence.","Check job status for queued/failed exports.","After an uncertain import, inspect records and audit history before retrying: imports have no durable replay guarantee.","Allow asynchronous search updates before checking discovery."],
      }
    ],
    related: ["catalog","administration","entity-identifiers","api"],
  },
  {
    slug: "administration",
    title: "Administration and access",
    summary: "Manage access, configuration and accountable changes.",
    category: "Administration",
    audience: "Administrators · Team leads",
    sections: [
      {
        id: "access-model", title: "Assign access by responsibility",
        paragraphs: ["System manages users and roles. Assign permissions by responsibility; read, write, publish and channel-scoped access are separate. The backend enforces every request."],
      },
      {
        id: "configuration", title: "Use the central configuration workspace",
        paragraphs: ["System → Configuration groups settings with independent scope and save/publication actions. Older installations may expose the same screens directly in navigation."],
        table: {"headers":["Setting","Scope"],"rows":[["Delivery & pickup","Selected store; immediate policy changes."],["Delivery fee","Installation-wide; new checkout reviews."],["Tax","Highest-priority active matching geographic rule."],["Markets","One reviewed live market per installation."],["Themes","Permitted channel assignments."],["Assistant","New requests after configuration changes."]]},
      },
      {
        id: "change-workflow", title: "Make a traceable administrative change",
        steps: ["Confirm the owning screen, store/channel and current state.","Check required permissions and affected records.","Enter a reason where requested.","Save/publish that form; there is no cross-section bulk save.","Verify the result and use audit history when investigating changes."],
      },
      {
        id: "access-troubleshooting", title: "Resolve missing controls",
        bullets: ["Missing links can indicate missing read permission.","Disabled controls can indicate read-only access.","Theme editing does not grant publication or assignment.","Reload and reconcile stale revisions.","Limit customer diagnostics and exports to authorized operators."],
      }
    ],
    related: ["security","import-export","storefront","delivery"],
  },
  {
    slug: "entity-identifiers",
    title: "Entity identifiers",
    summary: "Use readable IDs while retaining stable UUID relationships.",
    category: "Administration",
    audience: "Operators · Support teams · Integrators",
    sections: [
      {
        id: "two-identifiers", title: "Two identifiers, two purposes",
        paragraphs: ["Numeric entity_id helps operators identify records. UUID id remains the route, relationship, event and integration key.","Numbers are unique per table per installation. Product 12 and customer 12 differ; include entity type and store context."],
      },
      {
        id: "operator-usage", title: "Find and communicate a record",
        steps: ["Find the Entity ID column or label.","Search supported lists with 123 or #123.","Sort numerically or include IDs in exports.","Use order numbers, ticket numbers or SKUs where the workflow expects them."],
      },
      {
        id: "integration-contract", title: "Follow the response contract",
        bullets: ["Read-only and database-generated: omit from create/edit inputs.","Existing UUID routes and relationships stay UUID-based.","Identifiers are immutable; gaps are expected.","Allowed range: 1–9,007,199,254,740,991, exactly representable in JavaScript.","Historical receipts may omit the number; never substitute zero."],
      },
      {
        id: "coverage", title: "Coverage and reference fields",
        paragraphs: ["The initial rollout covers 43 business tables. Sessions, logs, junctions and projections keep existing keys.","Older fields named entity_id in audit, translation or override records may reference UUIDs. Follow each response schema."],
        note: "An identifier grants no access; ownership and permissions still apply.",
      }
    ],
    related: ["administration","api","import-export","checkout-orders"],
  },
  {
    slug: "support",
    title: "Support tickets and review moderation",
    summary: "Handle tickets and moderate customer reviews.",
    category: "Operations",
    audience: "Customer service · Moderation teams",
    sections: [
      {
        id: "support-workspace", title: "Review the support queue",
        paragraphs: ["Support → Support tickets shows subject, priority, status and creation time. Open a ticket for conversation and commerce context.","Use the customer-facing ticket number; Entity ID is a separate reference."],
      },
      {
        id: "ticket-workflow", title: "Resolve a customer issue",
        steps: ["Read the conversation and related operational records.","Complete required actions in their owning workflow.","Enter a reply and choose the available status.","Submit once; verify the refreshed conversation.","Inspect current state before repeating an uncertain reply."],
      },
      {
        id: "separate-outcomes", title: "Keep replies aligned with operational outcomes",
        paragraphs: ["A reply does not cancel an order, change an address or issue a refund. Confirm the saved operational result before reporting completion.","Investigate delivery through coverage, stock, calendars and capacity; compare price complaints with recorded order amounts."],
      },
      {
        id: "reviews", title: "Moderate product reviews",
        paragraphs: ["Open Marketing → Reviews → Review decision. Enter a customer-visible reason; approve to publish or reject to remove from public reviews.","After a concurrent change, refresh and review the latest version."],
      },
      {
        id: "escalation", title: "Prepare a useful escalation",
        bullets: ["Include store, ticket and order/product references.","Describe expected/observed behavior, time and request ID.","Share only customer details needed for the investigation."],
      }
    ],
    related: ["customers","checkout-orders","fulfillment","ai-assistant"],
  },
  {
    slug: "architecture",
    title: "Architecture and domain boundaries",
    summary: "Understand service responsibilities and commerce authority.",
    category: "Developers",
    audience: "Architects · Integration engineers · Platform teams",
    sections: [
      {
        id: "service-map", title: "Service responsibilities",
        table: {"headers":["Component","Responsibility"],"rows":[["Rust gateway","Authentication, domain operations and receipts."],["PostgreSQL","Transactional records, constraints and migrations."],["Admin/storefront","Typed operational and shopping interfaces."],["Node renderer","Public documents from approved snapshots."],["Python assistant","Orchestration through scoped capabilities."],["Node language engine","Supported interpretation contracts."],["Workers","Search, reporting, exports and asynchronous work."]]},
      },
      {
        id: "authority", title: "Keep authority in the owning domain",
        paragraphs: ["Domain services own catalog, stock, checkout, orders and other business rules. The gateway authenticates and admits requests.","Clients collect intent. The backend validates current identity, price, stock and revisions; committed records or receipts establish success."],
      },
      {
        id: "consistency", title: "Plan for synchronous and asynchronous state",
        bullets: ["Commerce transactions own related writes and reservations.","Search and reporting are derived, asynchronous views.","Published snapshots remain separate from revisioned drafts.","Availability subtracts live holds, independently of cleanup backlog.","Monitor worker tasks and dependency health."],
      },
      {
        id: "integration-design", title: "Design integrations around contracts",
        paragraphs: ["Use supported APIs and preserve required revisions/replay keys. Keep business validation in its owning domain.","Each client has an independent database and configuration. Channels, themes and stock pools do not provide client isolation."],
      }
    ],
    related: ["api","security","deployment","ai-assistant"],
  },
  {
    slug: "api",
    title: "API reference",
    summary: "Explore endpoints, authentication and OpenAPI schemas.",
    category: "Developers",
    audience: "Integration engineers · Application developers",
    sections: [
      {
        id: "contract", title: "Start with the deployed contract",
        paragraphs: ["The read-only public reference covers selected storefront/customer endpoints with downloadable OpenAPI JSON. Admin/internal contracts are excluded.","Use the approved store origin and /api/v1/... paths. Confirm version and access with Rocento; no generally available developer API, stability commitment or self-service key flow is released."],
      },
      {
        id: "request-security", title: "Use the correct identity context",
        bullets: ["Customer ownership follows verified bearer identity.","Admin operations require sessions and current permissions.","Protected mutations enforce origin checks and X-Commerce-Request: 1 where required.","Request bodies cannot grant ownership or authority.","Assistant delegation is separately scoped."],
      },
      {
        id: "integration-sequence", title: "Integrate an operation safely",
        steps: ["Read the deployed operation schema.","Use approved authentication and required permissions.","Retain current revisions, quotes and selections.","Submit supported fields; entity_id is read-only.","Handle validation, access, stale-state and unavailable responses distinctly.","Reconcile successful writes to their record or receipt."],
      },
      {
        id: "retries", title: "Respect operation-specific retry rules",
        paragraphs: ["Retry only under the operation’s contract. Preserve the original idempotency key where supported. Imports lack durable replay protection; inspect records/audit before retrying. Reload stale revisions."],
      },
      {
        id: "health", title: "Distinguish liveness from readiness",
        paragraphs: ["/health is liveness; /ready checks database/schema and worker health. Keep operator diagnostics within the intended access boundary."],
      }
    ],
    related: ["architecture","entity-identifiers","security","deployment"],
  },
  {
    slug: "security",
    title: "Security and operational controls",
    summary: "Understand access and operational security controls.",
    category: "Developers",
    audience: "Security reviewers · Administrators · Platform operators",
    sections: [
      {
        id: "identity-permissions", title: "Identity and authorization",
        paragraphs: ["Customer requests are identity- and ownership-scoped. Admin requests require sessions and current permissions. Read, write, publish and channel access are independent.","Server checks enforce access; identifiers and navigation visibility grant no authority."],
      },
      {
        id: "request-controls", title: "Request and secret handling",
        bullets: ["Protected admin mutations enforce request/origin safeguards.","Authentication throttling follows trusted ingress configuration.","Store secrets server-side; exclude them from bundles, logs and exports.","Delegate scoped assistant capabilities without general commerce credentials.","Restrict customer diagnostics and exports."],
      },
      {
        id: "publication-boundary", title: "Public and private content boundaries",
        paragraphs: ["Public documents require approved identity and active/published records. Private drafts are excluded; theme previews require admin sessions.","Indexing preferences and robots directives do not replace access control."],
      },
      {
        id: "operations", title: "Operate the controls",
        steps: ["Assign named users and review roles as responsibilities change.","Manage and rotate secrets through approved deployment controls.","Review audit evidence and restrict diagnostic permissions.","Monitor readiness, dependencies and failed jobs.","Back up data and test restoration.","Verify public-edge controls and client isolation."],
        note: "Certification, compliance and recovery commitments require separately verified scope and agreements.",
      }
    ],
    related: ["administration","architecture","api","deployment"],
  },
  {
    slug: "deployment",
    title: "Deployment and launch readiness",
    summary: "Prepare, verify and launch an isolated installation.",
    category: "Developers",
    audience: "Platform operators · Implementation teams",
    sections: [
      {
        id: "installation", title: "Prepare the installation boundary",
        paragraphs: ["Give each client an independent deployment, database, secrets and storage. Migrations establish core schema; industry installation adds starter attributes.","Configure merchant products, stock, branding, delivery and tax separately."],
      },
      {
        id: "deployment-sequence", title: "Deploy a matched release",
        steps: ["Review the target environment, release and migrations.","Confirm backups and tested restoration.","Deploy compatible services and dependencies.","Apply forward migrations; preserve migration history.","Verify database, media, search, analytics and workers.","Configure approved public identity and environment protections.","Run acceptance checks before live cutover."],
      },
      {
        id: "acceptance", title: "Use a launch acceptance checklist",
        bullets: ["Admin sign-in and intended role access.","Correct catalog, media, stock and market facts.","Expected delivery/pickup, schedules and capacity.","Verified order with correct totals.","Published theme, navigation, content and languages.","Correct public host, metadata, indexing and feeds.","Enabled assistant actions with verified outcomes.","Current reports/jobs and available recovery procedures."],
      },
      {
        id: "recovery-monitoring", title: "Monitor and recover deliberately",
        paragraphs: ["Monitor readiness, dependency health and asynchronous job freshness. Liveness alone is insufficient.","Roll back compatible releases while retaining commerce records, receipts and supported additive schema. Validate backups and restoration per environment before assigning recovery commitments."],
      }
    ],
    related: ["getting-started","architecture","api","security","discoverability"],
  },
];
