"use client";

import { useCallback, useEffect, useState } from "react";
import rocentoLogo from "../../../packages/ui/src/brand/rocento-logo-320.webp";
import { api } from "./client";
import type { Setup } from "./provisioning-status";

const date = (value: string | null | undefined) => value ? new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Not available";

export function ActiveStore({ tenantId, brand, slug, email, plan, theme, onSignOut, signOutError }: {
  tenantId: string; brand: string; slug: string; email: string; plan: string; theme: string;
  onSignOut: () => Promise<void>; signOutError: string;
}) {
  const [store, setStore] = useState<Setup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void api<Setup>(`stores/${tenantId}/provisioning`).then(result => {
      if (!cancelled) { setStore(result); setError(""); }
    }).catch(() => {
      if (!cancelled) setError("We couldn’t refresh your store details. Please try again.");
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tenantId, revision]);
  const signOut = useCallback(async () => {
    setSigningOut(true);
    try { await onSignOut(); } finally { setSigningOut(false); }
  }, [onSignOut]);
  const active = store?.lifecycleStatus === "ACTIVE";
  return <div className="store-workspace">
    <header className="setup-topbar">
      <a className="wordmark" href="/" aria-label="Rocento workspace"><img src={rocentoLogo.src} alt="Rocento" width="320" height="77" /></a>
      <span className="workspace-label">My store</span>
      <button className="back" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? "Signing out…" : "Sign out"}</button>
    </header>
    <main className="store-overview">
      <div className="store-overview-heading"><div><p className="eyebrow">YOUR COMMERCE WORKSPACE</p>
        <h1>Welcome back to {brand}</h1><p>Your store, account and service details in one place.</p>
      </div><button className="back" disabled={loading} onClick={() => setRevision(value => value + 1)}>{loading ? "Refreshing…" : "Refresh details"}</button></div>
      {(error || signOutError) && <p className="error" role="alert">{error || signOutError}</p>}
      <section className="store-summary" aria-label="Store overview">
        <div><span className="eyebrow">STORE STATUS</span><h2>{store ? active ? "Your store is active" : store.lifecycleStatus.toLowerCase().replaceAll("_", " ") : "Loading store details…"}</h2>
          <p>{active ? "Open your store admin to manage products, orders and customers." : "Your store details remain here. Refresh to check its current availability."}</p>
          <div className="save-actions">
            {active && store.adminUrl && <a className="primary" href={store.adminUrl} target="_blank" rel="noopener noreferrer">Open store admin ↗</a>}
            {active && store.storefrontUrl && <a className="back" href={store.storefrontUrl} target="_blank" rel="noopener noreferrer">Open storefront ↗</a>}
          </div>
        </div><div className="store-plan"><span>Current plan</span><strong>{plan}</strong><span>Coverage ends</span><strong>{date(store?.serviceEndsAt)}</strong></div>
      </section>
      <div className="store-detail-grid">
        <section className="store-detail-card"><h2>Store details</h2><dl>
          <div><dt>Store name</dt><dd>{brand}</dd></div>
          <div><dt>Storefront address</dt><dd>{slug}.rocento.com</dd></div>
          <div><dt>Admin address</dt><dd>{slug}-admin.rocento.com</dd></div>
          <div><dt>Storefront theme</dt><dd>{theme || "Not available"}</dd></div>
        </dl></section>
        <section className="store-detail-card"><h2>Account & service</h2><dl>
          <div><dt>Account email</dt><dd>{email}</dd></div>
          <div><dt>Plan</dt><dd>{plan}</dd></div>
          <div><dt>Service started</dt><dd>{date(store?.serviceStartsAt)}</dd></div>
          <div><dt>Coverage ends</dt><dd>{date(store?.serviceEndsAt)}</dd></div>
        </dl><p>For plan or service changes, contact Rocento with your store address.</p></section>
      </div>
    </main>
  </div>;
}
