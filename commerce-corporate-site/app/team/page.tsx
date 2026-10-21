import type { Metadata } from "next";
import Link from "next/link";
import { SiteIcon } from "@/components/site-icon";
import { site } from "@/lib/site";

const linkedin = "https://www.linkedin.com/in/mohammed-omar-880131161/";
const description =
  "Meet Mohammed Omar, the founder of Rocento, and connect through his public LinkedIn profile.";

export const metadata: Metadata = {
  title: "Team & Founders",
  description,
  alternates: { canonical: "/team/" },
  openGraph: { title: "Team & Founders | Rocento", description, url: "/team/" },
};

export default function TeamPage() {
  const root = site.url.replace(/\/$/, "");
  return (
    <div className="container team-page">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify({
            "@context": "https://schema.org",
            "@graph": [
              {
                "@type": "Person",
                "@id": `${root}/team/#mohammed-omar`,
                name: "Mohammed Omar",
                jobTitle: "Founder",
                url: `${root}/team/`,
                sameAs: [linkedin],
                worksFor: { "@id": `${site.url}#organization` },
              },
              {
                "@type": "Organization",
                "@id": `${site.url}#organization`,
                name: "Rocento",
                url: root,
                founder: { "@id": `${root}/team/#mohammed-omar` },
              },
            ],
          }).replace(/</g, "\\u003c"),
        }}
      />
      <header className="page-hero">
        <p className="eyebrow">TEAM & FOUNDERS</p>
        <h1>The people behind <em>Rocento.</em></h1>
        <p>
          Building a connected foundation for commerce, with a clear purpose
          and a founder-led approach.
        </p>
      </header>
      <section className="founder-profile" aria-labelledby="founder-name">
        <div className="founder-portrait">
          {/* Show the original portrait above the event banner without altering the photograph. */}
          <img
            src="/images/team/mohammed-omar.jpeg"
            alt="Mohammed Omar, founder of Rocento"
            width={1280}
            height={1280}
          />
        </div>
        <div className="founder-details">
          <p className="eyebrow">FOUNDER</p>
          <h2 id="founder-name">Mohammed Omar</h2>
          <p className="founder-role">Founder, Rocento</p>
          <p>
            Mohammed Omar is the founder of Rocento. Rocento is currently led
            by Mohammed as its sole founder.
          </p>
          <p>
            Our mission is to build commerce infrastructure that connects daily
            operations, customer experiences and intelligent systems.
          </p>
          <a className="text-link" href={linkedin} target="_blank" rel="noopener noreferrer">
            View Mohammed’s LinkedIn profile <SiteIcon />
          </a>
        </div>
      </section>
      <section className="team-contact">
        <p className="eyebrow">GET IN TOUCH</p>
        <h2>Start a conversation.</h2>
        <p>For product enquiries, partnerships or company information, contact Rocento.</p>
        <Link className="text-link" href="/about/#contact">
          Contact us <SiteIcon />
        </Link>
      </section>
    </div>
  );
}
