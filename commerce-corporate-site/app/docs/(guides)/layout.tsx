import Link from "next/link";
import { DocsSearch } from "@/components/docs-search";
import { DocsSidebar } from "@/components/docs-sidebar";
import { docs, docCategories, docText } from "@/lib/docs";
import "../docs.css";

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <div className="docs-site">
    <div className="docs-toolbar"><div><Link href="/docs/">Documentation</Link><span className="docs-toolbar-divider">/</span><span>Commerce user guides</span></div><DocsSearch items={docs.map((doc) => ({ slug: doc.slug, title: doc.title, summary: doc.summary, category: doc.category, text: docText(doc) }))} /></div>
    <div className="docs-workspace"><DocsSidebar groups={docCategories.map((category) => ({ title: category, items: docs.filter((doc) => doc.category === category).map(({ slug, title }) => ({ slug, title })) }))} /><div className="docs-main">{children}</div></div>
  </div>;
}
