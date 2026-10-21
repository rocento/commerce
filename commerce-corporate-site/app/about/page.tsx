import { SiteIcon } from "@/components/site-icon";
import { BrandLogo } from "@/components/brand-logo";
import Link from "next/link";
import { ContactForm } from "@/components/contact-form";
export const metadata = {
  title: "About",
  description:
    "Building commerce infrastructure designed for intelligent systems from the beginning.",
  alternates: { canonical: "/about/" },
  openGraph: {
    title: "About Rocento",
    description:
      "Commerce infrastructure designed for intelligent systems from the beginning.",
  },
};
export default function About() {
  return (
    <div className="container about-page">
      <header className="page-hero">
        <p className="eyebrow">ABOUT ROCENTO</p>
        <h1>
          A new foundation
          <br />
          for <em>commerce.</em>
        </h1>
        <p>
          Our mission is to build commerce infrastructure designed for
          intelligent systems from the beginning.
        </p>
      </header>
      <section className="about-statement">
        <BrandLogo iconOnly />
        <div>
          <h2>Commerce is more than a transaction.</h2>
          <p>
            It is a sequence of decisions, signals and interactions. We are
            building Rocento around that complete picture: commerce, behavioral
            data, analytics and controlled AI capabilities, connected by design.
          </p>
          <p>
            We help commerce teams bring daily operations and customer experiences
            together. Flexible storefronts, structured product information and
            connected reporting give teams a foundation they can build on.
          </p>
          <Link className="text-link" href="/platform/">
            Understand the platform <SiteIcon />
          </Link>
        </div>
      </section>
      <section className="team-contact">
        <p className="eyebrow">THE PEOPLE BEHIND ROCENTO</p>
        <h2>Meet our founder.</h2>
        <p>Rocento is founded and led by Mohammed Omar.</p>
        <Link className="text-link" href="/team/">
          Team & Founders <SiteIcon />
        </Link>
      </section>
      <section className="about-bottom" id="contact">
        <p className="eyebrow">CONVERSATIONS & COLLABORATION</p>
        <h2>Let’s discuss your commerce needs.</h2>
        <p>
          Tell us about your business, your current systems and the experience
          you want to create. Contact us for product enquiries, demonstrations
          and partnership discussions.
        </p>
        <ContactForm />
      </section>
    </div>
  );
}
