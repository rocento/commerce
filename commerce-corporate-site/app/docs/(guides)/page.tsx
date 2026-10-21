import type { Metadata } from "next";
import Link from "next/link";
import { BreadcrumbJsonLd } from "@/components/discovery-page";
import { DocsScreenshot } from "@/components/docs-screenshot";
import { docs, docCategories, docsRefreshDate, learningPaths, getDoc } from "@/lib/docs";

export const metadata: Metadata = {
  title: "Documentation",
  description: "Task-based Rocento guides for store setup, commerce operations, marketing, mobile apps and integrations.",
  alternates: { canonical: "/docs/" },
  openGraph: { title: "Rocento documentation", description: "Find your next step, from store setup to mobile publication." },
};
const categoryId = (title: string) => title.toLowerCase().replaceAll(" ", "-");
export default function DocsHome() {
  return <>
    <BreadcrumbJsonLd items={[{ name: "Home", path: "/" }, { name: "Documentation", path: "/docs/" }]} />
    <div className="docs-article-grid"><article className="docs-article">
      <nav className="docs-breadcrumb" aria-label="Breadcrumb"><Link href="/">Home</Link><span aria-hidden="true">›</span><span>Documentation</span></nav>
      <header className="docs-home-hero"><p className="docs-kicker">THE ROCENTO HANDBOOK</p><h1>Build your store.<br />Run it with confidence.</h1><p>Practical guides for every team behind the customer journey. Start with a task, follow a workflow, or find a feature.</p></header>
      <div className="docs-hub-actions"><Link className="docs-start-link" href="/docs/getting-started/">Start with store setup <span aria-hidden="true">→</span></Link><Link href="/docs/launch-checklist/">Open the launch checklist <span aria-hidden="true">↗</span></Link></div>
      <section id="learning-paths" className="docs-paths" aria-labelledby="paths-heading"><div className="docs-hub-heading"><span>01 / FIND YOUR NEXT STEP</span><h2 id="paths-heading">What are you working on?</h2><p>Follow a short path through the guides that matter to your task.</p></div>
        {learningPaths.map((path, index) => <details className="docs-path" key={path.title} open={index === 0}><summary><span className="docs-path-number">0{index + 1}</span><span><strong>{path.title}</strong><small>{path.description}</small></span><span className="docs-path-plus" aria-hidden="true">+</span></summary><ol>{path.slugs.map(slug => { const doc = getDoc(slug)!; return <li key={slug}><Link prefetch={false} href={`/docs/${slug}/`}><strong>{doc.title}</strong><span>{doc.summary}</span></Link></li>; })}</ol></details>)}
      </section>
      <section id="publication-flow" className="docs-publication" aria-labelledby="publication-heading"><div className="docs-hub-heading"><span>02 / UNDERSTAND THE WORKFLOW</span><h2 id="publication-heading">From an edit to an experience.</h2><p>Themes, campaigns, email templates and mobile experiences each have their own review and publication controls.</p></div><ol className="docs-publish-flow">{[["Prepare", "Make changes in the feature’s own workspace."], ["Review", "Check the saved version, preview and required validation."], ["Publish", "Use the feature’s authorized publication action."], ["Verify", "Confirm the result in the customer experience."]].map(([title, text], i) => <li key={title}><span aria-hidden="true">0{i + 1}</span><strong>{title}</strong><p>{text}</p></li>)}</ol><p className="docs-flow-note">Saving a draft is not publication. Settings such as delivery policy can take effect immediately; check each guide before making a change.</p></section>
      <section id="recent-guides" className="docs-recent" aria-labelledby="recent-heading"><div className="docs-hub-heading"><span>03 / NEW IN THE HANDBOOK</span><h2 id="recent-heading">More of the platform, explained.</h2></div><div className="docs-new-grid">{["notifications", "email-templates", "mobile-app-studio", "knowledge-authoring"].map(slug => { const doc = getDoc(slug)!; return <Link prefetch={false} key={slug} href={`/docs/${slug}/`}><small>{doc.category}</small><h3>{doc.title} <span aria-hidden="true">↗</span></h3><p>{doc.summary}</p></Link>; })}</div></section>
      <section className="docs-home-guides" id="guide-directory" aria-labelledby="browse-guides"><div className="docs-hub-heading"><span>04 / COMPLETE REFERENCE</span><h2 id="browse-guides">Browse all {docs.length} guides</h2></div><div className="docs-directory">{docCategories.map(category => <section className="docs-topic" id={categoryId(category)} key={category}><h3>{category}</h3><ul>{docs.filter(doc => doc.category === category).map(doc => <li key={doc.slug}><Link prefetch={false} href={`/docs/${doc.slug}/`}>{doc.title}<span aria-hidden="true">↗</span></Link></li>)}</ul></section>)}</div></section>
      <section className="docs-workspace-preview" id="admin-workspace"><h2>The Admin workspace</h2><DocsScreenshot name="overview" compact /></section>
      <footer className="docs-article-footer"><span>Directory updated: {docsRefreshDate}</span><Link href="/about/#contact">Contact support ↗</Link></footer>
    </article><aside className="docs-toc"><p>ON THIS PAGE</p><nav aria-label="On this page"><a href="#learning-paths">Find your next step</a><a href="#publication-flow">Publication workflow</a><a href="#recent-guides">New guides</a><a href="#guide-directory">All guides</a><a href="#admin-workspace">Admin workspace</a></nav></aside></div>
  </>;
}
