import type { ReactNode } from "react";

export function PurchaseAssurance({ kind, title, children }: { kind: "delivery" | "secure"; title: string; children: ReactNode }) {
  return <div className="purchase-assurance">
    <span className="purchase-assurance-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {kind === "delivery" ? <><path d="M3 6h11v11H3zM14 10h4l3 4v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></> : <><path d="m12 3 8 3v6c0 4.5-8 9-8 9S4 16.5 4 12V6l8-3Z"/><path d="m8.5 12 2.3 2.3 4.7-4.6"/></>}
      </svg>
    </span>
    <div className="purchase-assurance-copy"><strong>{title}</strong>{children}</div>
  </div>;
}
