import { additionalDocs } from "./docs-additions";
import { docArticles, type DocArticle } from "./docs-content";

export const docs: DocArticle[] = [
  ...docArticles.map(doc => doc.slug === "promotions" ? { ...doc, category: "Marketing" } : doc),
  ...additionalDocs,
  {
    slug: "fulfillment",
    title: "Fulfillment guide",
    summary: "Connect stock, coverage, schedules and capacity for delivery or pickup.",
    category: "Operations",
    audience: "Store operators · Fulfillment teams",
    sections: [
      { id: "guide-flow", title: "Delivery & pickup flow", paragraphs: ["Choose a method, check coverage and stock, build a fulfillment plan, find a time, check capacity, and place the order."] },
      { id: "guide-modules", title: "Module reference", paragraphs: ["Store policy, locations, stock pools, inventory, global stock, service areas, global delivery coverage, schedules, capacity rules, and orders."] },
      { id: "guide-setup", title: "Recommended setup order", paragraphs: ["Connect locations and stock pools, add quantities, enable fulfillment methods, configure schedules and limits, then validate checkout."] },
      { id: "guide-help", title: "Troubleshooting", paragraphs: ["Resolve missing pickup, unavailable addresses, absent time windows, insufficient stock, and full capacity."] },
    ],
    related: ["inventory", "delivery", "checkout-orders"],
  },
];

export const docCategories = ["Start here", "Commerce", "Operations", "Storefront", "Marketing", "Mobile apps", "Intelligence", "Administration", "Developers"];
export const docsRefreshDate = "October 13, 2026";
export function docUpdatedLabel(doc: DocArticle) {
  return new Date(`${doc.updated ?? docsUpdated}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}
export const learningPaths = [
  { title: "Launch your store", description: "From the first product to a verified order.", slugs: ["getting-started", "catalog", "fulfillment", "launch-checklist"] },
  { title: "Run daily operations", description: "Keep stock, orders and customer support connected.", slugs: ["inventory", "checkout-orders", "support", "analytics"] },
  { title: "Grow customer relationships", description: "Connect audiences, offers and the right message.", slugs: ["customers", "promotions", "notifications", "email-templates"] },
  { title: "Build customer experiences", description: "Publish web and mobile experiences with confidence.", slugs: ["storefront", "languages-markets", "mobile-app-studio", "discoverability"] },
  { title: "Integrate and extend", description: "Understand contracts, boundaries and release workflows.", slugs: ["architecture", "api", "knowledge-authoring", "deployment"] },
];
export const docsUpdated = "2026-10-04";
export function getDoc(slug: string) { return docs.find((doc) => doc.slug === slug); }
export function docText(doc: DocArticle) {
  return [doc.title, doc.summary, doc.category, ...doc.sections.flatMap((section) => [
    section.title, ...(section.paragraphs ?? []), ...(section.bullets ?? []),
    ...(section.steps ?? []), section.note ?? "", ...(section.table?.rows.flat() ?? []),
  ])].join(" ");
}
