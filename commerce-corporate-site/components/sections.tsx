import { SiteIcon } from "@/components/site-icon";
import { BrandLogo } from "@/components/brand-logo";
import Link from "next/link";
import { capabilities, demos } from "@/lib/site";
export function SectionHeader({
  number,
  label,
  title,
  description,
}: {
  number: string;
  label: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="section-heading">
      <p className="eyebrow">
        <span>{number}</span> {label}
      </p>
      <h2>{title}</h2>
      {description && <p className="section-description">{description}</p>}
    </div>
  );
}
export function ArchitectureDiagram({ hero = false }: { hero?: boolean }) {
  return (
    <div className={`architecture ${hero ? "hero-architecture" : ""}`}>
      <div className="diagram-caption">
        <span className="status-dot" /> CONNECTED BY DESIGN <span>R / 01</span>
      </div>
      <div className="orbit orbit-one" />
      <div className="orbit orbit-two" />
      <div className="diagram-stack">
        <div className="diagram-node node-experience">
          <SiteIcon className="node-icon" name="commerce" />
          <div>
            <small>01 / EXPERIENCE</small>
            <strong>Commerce</strong>
          </div>
          <span className="node-detail">Every interaction</span>
        </div>
        <div className="connector" />
        <div className="signal-row">
          <span>Transactions</span>
          <span>Behavior</span>
          <span>Events</span>
        </div>
        <div className="connector" />
        <div className="diagram-node node-context">
          <SiteIcon className="node-icon" name="agents" />
          <div>
            <small>02 / UNDERSTANDING</small>
            <strong>Commerce context</strong>
          </div>
          <span className="context-dot" />
        </div>
        <div className="connector" />
        <div className="diagram-node node-intelligence">
          
          <div>
            <small>03 / INTELLIGENCE</small>
            <strong>AI + Agents</strong>
          </div>
          <span className="node-detail">Scoped capabilities</span>
        </div>
        <div className="connector" />
        <div className="outcomes">
          <span>Discover</span>
          <span>Reason</span>
          <span>Assist</span>
        </div>
      </div>
      <div className="diagram-bottom">
        COMMERCE <SiteIcon /> BEHAVIOR <SiteIcon /> CONTEXT <SiteIcon /> ACTION
      </div>
    </div>
  );
}
export function CapabilityGrid() {
  return (
    <div className="capability-grid">
      {capabilities.map((c, i) => (
        <Link href={`/platform/#${c.id}`} className="capability" key={c.id}>
          <div className="cap-top">
            <SiteIcon className="cap-symbol" name={c.id} />
            <span>0{i + 1}</span>
          </div>
          <h3>{c.title}</h3>
          <p>{c.description}</p>
          <div className="cap-bottom">
            <small>{c.status}</small>
            <span aria-hidden="true"><SiteIcon /></span>
          </div>
        </Link>
      ))}
    </div>
  );
}
export function DemoCards() {
  return (
    <div className="demo-grid">
      {demos.map((d) => (
        <article className={`demo-card ${d.id}`} key={d.id}>
          <div className="demo-visual">
            <span className="demo-brand">
              {d.id === "pharmacy" ? "NOIR ROSÉ" : d.id === "grocery" ? "the daily harvest." : d.id === "electronics" ? "Rocento Tech" : "AUREL"}
            </span>
            <img
              src={d.image}
              alt={d.alt}
              width="640"
              height="480"
              loading="lazy"
            />
            <span className="demo-caption">
              ROCENTO / INDUSTRY EXPLORATIONS
            </span>
          </div>
          <div className="demo-body">
            <p className="eyebrow">{d.eyebrow}</p>
            <h3>{d.title}</h3>
            <p>{d.description}</p>
            {d.url ? (
              <a className="text-link" href={d.url}>
                Explore {d.title} Demo <SiteIcon />
              </a>
            ) : (
              <details>
                <summary>
                  About the {d.title} preview <span>↓</span>
                </summary>
                <p>
                  This preview illustrates a {d.title.toLowerCase()} storefront with sample products. Contact us to discuss a walkthrough.
                </p>
              </details>
            )}
          </div>
        </article>
      ))}
    </div>
  );
}
export function CTA() {
  return (
    <section className="closing container">
      <p className="eyebrow">READY FOR A CLOSER LOOK?</p>
      <h2>
        Make commerce easier to run.
        <br />
        <span>Make every journey easier to understand.</span>
      </h2>
      <Link className="button primary" href="/about/#contact">
        Discuss your requirements <span><SiteIcon /></span>
      </Link>
    </section>
  );
}
export function Footer() {
  return (
    <footer className="footer">
      <div className="container">
        <div className="footer-main">
          <div>
            <Link className="wordmark" href="/">
              <BrandLogo />
            </Link>
            <p>Connected commerce, built around real customer journeys.</p>
          </div>
          <div>
            <h3>Platform</h3>
            <Link href="/features/">Features</Link>
            <Link href="/industries/">Industries</Link>
            <Link href="/pricing/">Pricing</Link>
            <Link href="/security/">Security</Link>
          </div>
          <div>
            <h3>Resources</h3>
            <Link href="/knowledge/">Knowledge</Link>
            <Link href="/docs/">Documentation</Link>
            <Link href="/integrations/">Integrations</Link>
            <Link href="/changelog/">Changelog</Link>
            <Link href="/demo/">Demos</Link>
          </div>
          <div>
            <h3>Company</h3>
            <Link href="/about/">About</Link>
            <Link href="/team/">Team & Founders</Link>
            <Link href="/about/#contact">Contact</Link>
          </div>
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} Rocento</span>
          <span>Commerce that keeps the full picture in view.</span>
        </div>
      </div>
    </footer>
  );
}
