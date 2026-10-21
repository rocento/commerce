"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

export type SearchDoc = { slug: string; title: string; summary: string; category: string; text: string };
export function DocsSearch({ items }: { items: SearchDoc[] }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const id = useId();
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const results = terms.length ? items.map((item) => ({ item, score: terms.every((term) => item.text.toLowerCase().includes(term))
    ? terms.reduce((score, term) => score + (item.title.toLowerCase().includes(term) ? 5 : 1), 0) : 0 }))
    .filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).slice(0, 8).map(({ item }) => item) : [];

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && area.current?.contains(event.target as Node)) { event.preventDefault(); input.current?.focus(); setOpen(false); }
      if (event.key === "/" && !(event.target instanceof HTMLElement && (event.target.matches("input, textarea, select") || event.target.isContentEditable))) {
        event.preventDefault(); input.current?.focus(); setOpen(true);
      }
    };
    const outside = (event: PointerEvent) => { if (!area.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("keydown", key);
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", outside); };
  }, []);

  return <div className="docs-search" ref={area} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <label className="sr-only" htmlFor={id}>Search documentation</label>
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></svg>
    <input id={id} ref={input} type="search" autoComplete="off" placeholder="Search documentation…" value={query}
      aria-controls={open && terms.length > 0 ? `${id}-results` : undefined}
      onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.target.value); setOpen(true); }} />
    <kbd aria-hidden="true">/</kbd>
    {open && terms.length > 0 && <div className="docs-search-results" id={`${id}-results`}>
      <p className="docs-search-status" role="status">{results.length ? `${results.length} guide${results.length === 1 ? "" : "s"} found` : "No matching guides"}</p>
      {results.length ? <ul>{results.map((item) => <li key={item.slug}><Link href={`/docs/${item.slug}/`} onClick={() => { setOpen(false); setQuery(""); }}><small>{item.category}</small><strong>{item.title}<span aria-hidden="true">↗</span></strong><span>{item.summary}</span></Link></li>)}</ul>
        : <p className="docs-search-empty">Try a feature or task, such as “stock”, “delivery”, or “customer”.</p>}
    </div>}
  </div>;
}
