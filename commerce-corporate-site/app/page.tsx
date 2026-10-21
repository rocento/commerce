import { SiteIcon } from "@/components/site-icon";
import Link from "next/link";
import {
  ArchitectureDiagram,
  CapabilityGrid,
  CTA,
  DemoCards,
  SectionHeader,
} from "@/components/sections";
import { getArticles } from "@/lib/knowledge";
import { ArticleCard } from "@/components/knowledge";
export const metadata = { alternates: { canonical: "/" } };
export default function Home() {
  return (
    <>
      <section className="hero container">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="tiny-square" /> COMMERCE, WITH THE FULL PICTURE
          </p>
          <h1>
            Intelligent by nature.
            <br />
            Designed to <em>scale.</em>
          </h1>
          <p className="hero-description">
            Rocento brings your catalog, customers, orders, inventory and
            storefront together. Your team gets a clearer view of what
            customers need, and a practical foundation for helpful AI.
          </p>
          <div className="hero-actions">
            <Link prefetch={false} className="button primary" href="/platform/">
              See how Rocento works <span><SiteIcon /></span>
            </Link>
            <Link prefetch={false} className="button secondary" href="/#demos">
              Explore the demos <span><SiteIcon /></span>
            </Link>
          </div>
          <p className="hero-note">One place for commerce, customer context and assistance</p>
        </div>
        <ArchitectureDiagram hero />
      </section>
      <div className="foundation-strip container">
        <span>ONE STORE, ONE SHARED CONTEXT</span>
        <p>
          Discover <i><SiteIcon /></i> Choose <i><SiteIcon /></i> Buy <i><SiteIcon /></i> Learn <i><SiteIcon /></i> Improve
        </p>
        
      </div>
      <section className="section container story">
        <SectionHeader
          number="01"
          label="SEE MORE THAN THE ORDER"
          title="Understand the journey behind every order."
        />
        <div className="story-right">
          <h2>
            Rocento connects
            <br />
            <em>the moments between.</em>
          </h2>
          <p>
            A search. A product view. A cart left behind. Each moment says
            something about what a customer wants. Rocento connects those
            moments with orders, inventory and pricing so your team can respond
            with more confidence.
          </p>
          <div className="signal-tags">
            {[
              "Searches",
              "Product views",
              "Carts",
              "Orders",
              "Inventory",
              "Pricing",
              "Promotions",
              "Conversions",
            ].map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
          <Link prefetch={false} className="text-link" href="/knowledge/commerce-context/">
            From data to context <span><SiteIcon /></span>
          </Link>
        </div>
      </section>
      <section className="section capabilities-section" id="capabilities">
        <div className="container">
          <SectionHeader
            number="02"
            label="THE PLATFORM"
            title="The everyday work, connected."
            description="Manage the essentials in one system, then build smarter customer experiences on dependable commerce data."
          />
          <CapabilityGrid />
        </div>
      </section>
      <section className="section container native">
        <SectionHeader
          number="03"
          label="AI WITH SOMETHING REAL TO WORK WITH"
          title="Helpful AI starts with good context."
          description="Rocento connects product, customer and operational information first. AI can then assist within clear, deliberate boundaries."
        />
        <div className="comparison">
          <div className="traditional">
            <p className="eyebrow">COMMERCE OPERATIONS</p>
            <div>Products, customers and orders</div>
            <span>+</span>
            <div className="plugin">Inventory and pricing</div>
            <p>Current facts for everyday decisions.</p>
          </div>
          <div className="native-system">
            <p className="eyebrow">THE ROCENTO APPROACH</p>
            <div className="native-chain">
              {["Commerce", "Data", "Behavior", "Context", "AI"].map((n, i) => (
                <span key={n}>
                  <small>0{i + 1}</small>
                  {n}
                </span>
              ))}
            </div>
            <p>A shared foundation for intelligent commerce.</p>
          </div>
        </div>
      </section>
      <section className="experience-section">
        <div className="container">
          <SectionHeader
            number="04"
            label="FAMILIAR ON THE SURFACE. CONNECTED UNDERNEATH."
            title="A clearer view of how people shop."
          />
          <div className="journey-label">WHAT CUSTOMERS SEE</div>
          <div className="journey">
            {["Storefront", "Search", "Product", "Cart", "Checkout"].map(
              (s, i) => (
                <div key={s}>
                  <span className="journey-number">0{i + 1}</span>
                  <h3>{s}</h3>
                  <div className="journey-line" />
                  <p>
                    {
                      [
                        "Customer experience",
                        "Search activity",
                        "Product context",
                        "Cart activity",
                        "Order context",
                      ][i]
                    }
                  </p>
                </div>
              ),
            )}
          </div>
          <div className="journey-label bottom-label">
            WHAT ROCENTO CAN CONNECT
          </div>
          <p className="experience-note">
            Product discovery, customer accounts and checkout above. A
            foundation for contextual intelligence below. Learning and
            predictive models remain research directions.
          </p>
        </div>
      </section>
      <section className="section container" id="demos">
        <SectionHeader
          number="05"
          label="BUILT FOR DIFFERENT WORLDS"
          title="One platform. Different commerce experiences."
          description="See how one foundation can feel completely at home in different kinds of retail."
        />
        <DemoCards />
        <p className="section-footnote">
          Demo stores use sample products and illustrative imagery.
          More industries can build on the same foundation.
        </p>
      </section>
      <section className="section mobile-apps-section" id="mobile-apps">
        <div className="container">
          <SectionHeader
            number="06"
            label="MOBILE COMMERCE"
            title="Your brand. In your customers’ hands."
            description="Bring your store to iOS and Android with native and cross-platform mobile applications, built around your brand and connected to Rocento."
          />
          <div className="mobile-apps-grid">
            <article className="mobile-app-option">
              <SiteIcon name="mobile" className="mobile-app-icon" />
              <h3>Native mobile apps</h3>
              <p>
                Dedicated iOS and Android applications with an experience
                designed for each platform, from product discovery to checkout.
              </p>
              <span className="mobile-app-label">BUILT FOR EACH PLATFORM</span>
            </article>
            <article className="mobile-app-option">
              <SiteIcon name="cross-platform" className="mobile-app-icon" />
              <h3>Cross-platform apps</h3>
              <p>
                Reach customers on iOS and Android through a shared codebase,
                with a consistent shopping experience that reflects your brand.
              </p>
              <span className="mobile-app-label">ONE CODEBASE, BOTH PLATFORMS</span>
            </article>
            <article className="mobile-app-option mobile-app-source">
              <SiteIcon name="code" className="mobile-app-icon" />
              <h3>Your app. Your code.</h3>
              <p>
                Access to your mobile application’s source code is available,
                giving your team the flexibility to customize and extend it.
              </p>
              <p className="mobile-app-terms">
                Source code access and usage rights are subject to agreed
                scope, licensing terms and conditions.
              </p>
            </article>
          </div>
          <div className="mobile-apps-footer">
            <p>Choose the right approach for your business, your team and your customers.</p>
            <Link prefetch={false} className="button primary" href="/about/#contact">
              Discuss your mobile app <SiteIcon />
            </Link>
          </div>
        </div>
      </section>
      <section className="section container knowledge-home">
        <div className="heading-row">
          <SectionHeader
            number="07"
            label="FROM THE ROCENTO TEAM"
            title="Practical thinking for better commerce."
          />
          <Link prefetch={false} className="text-link" href="/knowledge/">
            Explore Knowledge <SiteIcon />
          </Link>
        </div>
        <div className="article-grid">
          {getArticles()
            .slice(0, 3)
            .map((a) => (
              <ArticleCard key={a.slug} article={a} />
            ))}
        </div>
      </section>
      <CTA />
    </>
  );
}
