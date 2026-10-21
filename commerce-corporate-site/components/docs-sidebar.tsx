"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export function DocsSidebar({ groups }: { groups: { title: string; items: { slug: string; title: string }[] }[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  return <aside className="docs-sidebar">
    <button className="docs-menu-button" type="button" aria-expanded={open} aria-controls="docs-navigation" onClick={() => setOpen(!open)}>Browse documentation <span aria-hidden="true">{open ? "−" : "+"}</span></button>
    <nav id="docs-navigation" aria-label="Documentation" className={open ? "is-open" : ""}>
      <p className="docs-nav-title">Rocento Commerce</p>
      <Link className="docs-overview-link" href="/docs/" aria-current={pathname.replace(/\/$/, "") === "/docs" ? "page" : undefined} onClick={() => setOpen(false)}>Documentation home</Link>
      {groups.map((group) => <details className="docs-nav-group" key={`${group.title}:${pathname}`} open={group.title === "Start here" || group.items.some(item => pathname.replace(/\/$/, "") === `/docs/${item.slug}`)}><summary>{group.title}</summary><ul>{group.items.map((item) => <li key={item.slug}><Link href={`/docs/${item.slug}/`} aria-current={pathname.replace(/\/$/, "") === `/docs/${item.slug}` ? "page" : undefined} onClick={() => setOpen(false)}>{item.title}</Link></li>)}</ul></details>)}
    </nav>
  </aside>;
}
