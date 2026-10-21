import type { ReactNode } from 'react';

const paths: Record<string, ReactNode> = {
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
  spark: <><path d="m12 3 2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2Z"/><path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6Z"/></>,
  chart: <><path d="M4 4v16h16M8 15l4-5 4 2 4-7"/><path d="M16 5h4v4"/></>,
  orders: <><path d="M6 4h12v17l-3-2-3 2-3-2-3 2V4Z"/><path d="M9 8h6M9 12h6"/></>,
  value: <><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 9h18M7 15h3"/></>,
  refund: <><path d="M4 10a8 8 0 1 1 1 8M4 4v6h6"/><path d="M12 8v5l3 2"/></>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 7a7 7 0 0 1 11.8-2L20 8M4 16l2.7 3A7 7 0 0 0 18.5 17"/></>,
  people: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/></>,
  network: <><rect x="8" y="3" width="8" height="6" rx="1"/><rect x="2" y="16" width="7" height="5" rx="1"/><rect x="15" y="16" width="7" height="5" rx="1"/><path d="M12 9v4M5.5 16v-3h13v3"/></>,
  box: <><path d="m3 7 9-4 9 4-9 4-9-4Zm0 0v10l9 4 9-4V7M12 11v10M7.5 5l9 4"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18M5 6.5h14M5 17.5h14"/></>,
  store: <><path d="m4 3-2 6a3 3 0 0 0 5 2 3 3 0 0 0 5 0 3 3 0 0 0 5 0 3 3 0 0 0 5-2l-2-6H4ZM4 12v9h16v-9M9 21v-6h6v6M8 3 7 9m9-6 1 6"/></>,
  tag: <><path d="M3 3h8l10 10-8 8L3 11V3Z"/><circle cx="7.5" cy="7.5" r="1"/></>,
  truck: <><path d="M2 5h12v12H2zM14 9h4l4 4v4h-8"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></>,
  support: <><path d="M4 13v-1a8 8 0 0 1 16 0v1M4 12H3v7h4v-7H4Zm16 0h1v7h-4v-7h3ZM20 19v1h-7"/></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/></>,
};

export function OverviewIcon({ name }: { name: string }) {
  return <svg className="overview-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] ?? paths.box}</svg>;
}
