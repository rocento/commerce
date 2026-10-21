import { SiteIcon } from "@/components/site-icon";
import Link from "next/link";
export default function NotFound() {
  return (
    <section className="container page-hero">
      <p className="eyebrow">404 / NOT FOUND</p>
      <h1>
        A different <em>direction.</em>
      </h1>
      <p>
        This page does not exist. Explore the platform or return to our latest
        thinking.
      </p>
      <Link className="button primary" href="/">
        Back to Rocento <SiteIcon />
      </Link>
    </section>
  );
}
