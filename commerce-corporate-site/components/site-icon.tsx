const paths: Record<string, string> = {
  right: "m9 5 7 7-7 7",
  left: "m15 5-7 7 7 7",
  commerce: "M4 8h16v12H4z M8 8V6a4 4 0 0 1 8 0v2",
  storefront: "M3 4h18v16H3z M3 9h18 M9 9v11",
  behavior: "M3 12h4l3-7 4 14 3-7h4",
  analytics: "M4 3v17h17 M8 16v-5 M13 16V7 M18 16v-9",
  ai: "M7 7h10v10H7z M10 10h4v4h-4z M9 3v4 M15 3v4 M9 17v4 M15 17v4 M3 9h4 M3 15h4 M17 9h4 M17 15h4",
  agents: "M4 4h6v6H4z M14 14h6v6h-6z M10 7h7v7 M7 10v7h7",
  mobile: "M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z M10 5h4 M11 19h2",
  "cross-platform": "M3 4h7v14H3z M14 6h7v14h-7z M6 15h1 M17 17h1 M10 8h4 M10 14h4",
  code: "m8 7-5 5 5 5 m8-10 5 5-5 5 M14 4l-4 16",
};

/** Decorative, font-independent icons: never rendered as platform emoji. */
export function SiteIcon({ name = "right", className = "" }: { name?: string; className?: string }) {
  return <svg className={`site-icon ${className}`} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name] || paths.right} /></svg>;
}
