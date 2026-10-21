const screenshots = {
  overview: { src: "admin-overview.png", width: 1440, height: 1724, alt: "Rocento Admin overview with sales metrics, a sales chart and links to daily operations.", caption: "The Admin workspace brings reports and daily operations together." },
  catalog: { src: "product-categories.png", width: 1440, height: 1050, alt: "Product category picker with Women and Shoes selected in the category tree.", caption: "Select categories, apply your choices, then save the product." },
  storefront: { src: "theme-categories.png", width: 1440, height: 900, alt: "Theme editor category picker showing Dresses as the source for a product section.", caption: "Choose the category that supplies products to a storefront section." },
  checkout: { src: "checkout.png", width: 1440, height: 1342, alt: "Rocento checkout with contact, delivery, payment and order summary sections.", caption: "Customers review delivery, payment and totals before placing an order." },
} as const;

export function DocsScreenshot({ name, compact = false }: { name: keyof typeof screenshots; compact?: boolean }) {
  const shot = screenshots[name];
  return <figure className={`docs-screenshot${compact ? " docs-screenshot-compact" : ""}`}>
    <a href={`/docs/images/${shot.src}`} target="_blank" rel="noopener noreferrer" aria-label={`${shot.alt} Open full-size screenshot in a new tab.`}>
      {/* Native image keeps the static export and original screenshot available. */}
      <img src={`/docs/images/${shot.src}`} alt={shot.alt} width={shot.width} height={shot.height} loading="lazy" />
      <span className="docs-image-zoom" aria-hidden="true">View full size ↗</span>
    </a>
    <figcaption>{shot.caption} <span>Sample data.</span></figcaption>
  </figure>;
}

export const sectionScreenshots: Record<string, { section: string; name: keyof typeof screenshots }> = {
  "getting-started": { section: "before-you-start", name: "overview" },
  "platform-overview": { section: "connected-platform", name: "overview" },
  catalog: { section: "categories", name: "catalog" },
  storefront: { section: "theme-workflow", name: "storefront" },
  "checkout-orders": { section: "review-and-placement", name: "checkout" },
  analytics: { section: "report-workflow", name: "overview" },
};
