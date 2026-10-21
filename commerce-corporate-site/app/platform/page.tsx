import { SiteIcon } from "@/components/site-icon";
import Link from "next/link";
import { ArchitectureDiagram, CTA } from "@/components/sections";
export const metadata = {
  title: "The platform",
  description:
    "Explore the commerce, data and controlled AI capabilities behind Rocento.",
  alternates: { canonical: "/platform/" },
  openGraph: {
    title: "The Rocento platform",
    description:
      "Commerce, data and intelligence in one connected architecture.",
  },
};
const sections = [
  [
    "commerce",
    "Commerce core",
    "A dependable transactional foundation.",
    "Catalog, customers, carts, checkout, orders, inventory and promotions form the operational center. AI assistance depends on authoritative commerce facts; it does not replace transactional rules.",
    "Core capability",
  ],
  [
    "storefront",
    "Composable storefront",
    "Your brand. Your customers. Their shopping experience.",
    "Create a storefront that reflects your brand and the customers you serve. Connect product discovery, search and purchasing in one consistent journey, with experiences tailored to customer segments and delivery areas. Adapt as your business grows, while keeping commerce operations connected.",
    "Core capability",
  ],
  [
    "admin",
    "Merchant administration",
    "A workspace for the people behind the store.",
    "Give your team one workspace to manage products, serve customers, fulfill orders and understand performance. Connected catalog, inventory, promotions and reporting help people make informed decisions throughout the working day.",
    "Core capability",
  ],
  [
    "apis",
    "APIs & documentation",
    "Connect commerce to the way you work.",
    "Build integrations around your business with clearly defined commerce APIs. Connect customer experiences and operational workflows through a shared foundation, with clear contracts between your systems.",
    "Integration foundation",
  ],
  [
    "behavior",
    "Behavioral data",
    "Signals with a purpose.",
    "Searches, product views, cart changes, checkout and conversion events add context to transactions. Useful signals need clear event definitions, identity boundaries and retention decisions. Collection alone is not a prediction model.",
    "Event collection",
  ],
  [
    "analytics",
    "Commerce analytics",
    "Operational activity, made legible.",
    "Revenue, product, customer, inventory and cohort reporting create a basis for operational understanding. Analytical context complements current prices, stock and order state; current availability and pricing remain governed by commerce services.",
    "Operational reporting",
  ],
  [
    "ai",
    "AI & machine learning",
    "A foundation for learning.",
    "Predictive recommendations, forecasting, intent, conversion and abandonment prediction, and AI-based segmentation are areas for continued development. These predictive models are not presented as validated production capabilities. Rule-based customer segmentation is available today using customer, completed-order and saved-cart data. Current shopping assistance uses bounded filtering and ranking grounded in catalog facts.",
    "Research & development",
  ],
  [
    "agents",
    "Controlled AI agents",
    "Useful assistance. Explicit boundaries.",
    "The assistant MVP retrieves commerce facts through tenant- and persona-scoped read-only tools and approved knowledge retrieval. Product discovery, order status and support flows have documented scope. Broader autonomous actions remain in development. Assistant quality, provider configuration and deployment readiness require evaluation for each use case.",
    "Assistant preview",
  ],
  [
    "security",
    "Security boundaries",
    "Access follows the application.",
    "Agents use approved application capabilities rather than unrestricted database access. Authorization, scoped tools and authoritative commerce responses establish boundaries. Production deployment requires security evaluation and operational controls. See the security overview for current assurance information.",
    "Design & ongoing validation",
  ],
  [
    "extensibility",
    "Extensibility",
    "Room to evolve without losing the foundation.",
    "Extend your storefront, connect new services and introduce new capabilities as your business evolves. A modular platform gives your teams room to improve customer experiences while keeping core commerce operations connected.",
    "Architectural approach",
  ],
];
export default function Platform() {
  return (
    <>
      <section className="container page-hero platform-hero">
        <div>
          <p className="eyebrow">THE ROCENTO PLATFORM</p>
          <h1>
            Commerce.
            <br />
            Context.
            <br />
            <em>Intelligence.</em>
          </h1>
          <p>
            One connected architecture, from the first interaction to the next
            informed action.
          </p>
          <Link className="text-link" href="#commerce">
            Explore the layers ↓
          </Link>
        </div>
        <ArchitectureDiagram />
      </section>
      <div className="container platform-layout">
        <nav className="platform-nav" aria-label="Platform sections">
          {sections.map(([id, title]) => (
            <a key={id} href={`#${id}`}>
              {title}
            </a>
          ))}
          <a href="#architecture">Architecture</a>
        </nav>
        <div>
          {sections.map(([id, title, heading, copy, status], i) => (
            <section className="platform-section" id={id} key={id}>
              <p className="eyebrow">
                {String(i + 1).padStart(2, "0")} / {title}
              </p>
              <h2>{heading}</h2>
              <p>{copy}</p>
              <span className="status-label">{status}</span>
            </section>
          ))}
          <section className="platform-section" id="architecture">
            <p className="eyebrow">11 / ARCHITECTURE</p>
            <h2>From interaction to informed action.</h2>
            <p>
              Customer experience <SiteIcon /> commerce platform <SiteIcon /> behavioral events <SiteIcon />
              commerce context <SiteIcon /> AI intelligence <SiteIcon /> controlled assistance.
              Prediction and autonomous actions are future extensions of this
              foundation.
            </p>
            <Link className="text-link" href="/knowledge/ai-native-commerce/">
              Read the architectural philosophy <SiteIcon />
            </Link>
          </section>
        </div>
      </div>
      <CTA />
    </>
  );
}
