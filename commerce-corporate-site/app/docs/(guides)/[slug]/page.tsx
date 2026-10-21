import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BreadcrumbJsonLd } from "@/components/discovery-page";
import { DocsScreenshot, sectionScreenshots } from "@/components/docs-screenshot";
import { FulfillmentGuide } from "@/components/fulfillment-guide";
import { docs, getDoc, docsUpdated, docUpdatedLabel, docText } from "@/lib/docs";
import { site } from "@/lib/site";

export function generateStaticParams() { return docs.filter(({ slug }) => slug !== "api").map(({ slug }) => ({ slug })); }
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params, doc = getDoc(slug);
  return doc ? { title: `${doc.title} — Docs`, description: doc.summary, alternates: { canonical: `/docs/${slug}/` }, openGraph: { title: `${doc.title} | Rocento Docs`, description: doc.summary } } : {};
}

export default async function DocPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params, doc = getDoc(slug);
  if (!doc || slug === "api") notFound();
  const related = doc.related.map(getDoc).filter((item) => item !== undefined);
  const minutes = slug === "fulfillment" ? 4 : Math.max(2, Math.ceil(docText(doc).split(/\s+/).length / 200));
  return <>
    <BreadcrumbJsonLd items={[{ name: "Home", path: "/" }, { name: "Documentation", path: "/docs/" }, { name: doc.title, path: `/docs/${slug}/` }]} />
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ "@context": "https://schema.org", "@type": "TechArticle", headline: doc.title, description: doc.summary, dateModified: doc.updated ?? docsUpdated, inLanguage: "en", url: `${site.url.replace(/\/$/, "")}/docs/${slug}/`, author: { "@type": "Organization", name: "Rocento" } }).replace(/</g, "\\u003c") }} />
    <div className="docs-article-grid"><article className="docs-article">
      <nav className="docs-breadcrumb" aria-label="Breadcrumb"><Link href="/docs/">Documentation</Link><span aria-hidden="true">/</span><span>{doc.category}</span></nav>
      <header className="docs-article-header"><h1>{doc.title}</h1><p>{doc.summary}</p><div className="docs-article-meta"><span>Updated {docUpdatedLabel(doc)}</span><span>{minutes} min read</span><span>{doc.audience}</span></div></header>
      <details className="docs-mobile-toc"><summary>On this page</summary><nav aria-label="Page sections">{doc.sections.map((section) => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}</nav></details>
      {slug === "fulfillment" ? <FulfillmentGuide /> : <div className="docs-prose">{doc.sections.map((section) => <section id={section.id} key={section.id}><h2><a href={`#${section.id}`}>{section.title}<span className="docs-heading-anchor" aria-hidden="true">#</span></a></h2>{section.paragraphs?.map((text) => <p key={text}>{text}</p>)}{section.bullets && <ul>{section.bullets.map((text) => <li key={text}>{text}</li>)}</ul>}{section.steps && <ol className="docs-steps">{section.steps.map((text) => <li key={text}>{text}</li>)}</ol>}{section.table && <div className="docs-table" role="region" aria-label={section.title} tabIndex={0}><table><thead><tr>{section.table.headers.map((text) => <th key={text} scope="col">{text}</th>)}</tr></thead><tbody>{section.table.rows.map((row, i) => <tr key={i}>{row.map((text, j) => <td key={j}>{text}</td>)}</tr>)}</tbody></table></div>}{sectionScreenshots[slug]?.section === section.id && <DocsScreenshot name={sectionScreenshots[slug].name} compact={sectionScreenshots[slug].name === "overview"} />}{section.note && <aside className="docs-note"><strong>Note</strong><p>{section.note}</p></aside>}</section>)}</div>}
      <section className="docs-related"><h2>Related guides</h2><div>{related.map((item) => <Link key={item.slug} href={`/docs/${item.slug}/`}><strong>{item.title} <span aria-hidden="true">→</span></strong></Link>)}</div></section>
      <footer className="docs-article-footer"><span>Updated {docUpdatedLabel(doc)}</span><Link href="/about/#contact">Contact support <span aria-hidden="true">↗</span></Link></footer>
    </article><aside className="docs-toc"><p>ON THIS PAGE</p><nav aria-label="On this page">{doc.sections.map((section) => <a key={section.id} href={`#${section.id}`}>{section.title}</a>)}</nav></aside></div>
  </>;
}
