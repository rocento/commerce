"use client";

import { useEffect, useState } from "react";
import { api } from "./client";

export type Setup = {
  lifecycleStatus: string;
  status: string | null;
  step: string | null;
  reason: string | null;
  storefrontUrl: string | null;
  adminUrl: string | null;
  serviceStartsAt: string | null;
  serviceEndsAt: string | null;
};

export function ProvisioningStatus({ tenantId, onActive }: { tenantId: string; onActive: (active: boolean) => void }) {
  const [setup, setSetup] = useState<Setup | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const result = await api<Setup>(`stores/${tenantId}/provisioning`);
        if (cancelled) return;
        setSetup(result);
        onActive(result.lifecycleStatus === "ACTIVE");
        setError(false);
        if (result.lifecycleStatus !== "ACTIVE" && result.status !== "FAILED") {
          timer = setTimeout(() => void refresh(), result.status === "BLOCKED" ? 30000 : 5000);
        }
      } catch {
        if (cancelled) return;
        setError(true);
        timer = setTimeout(() => void refresh(), 30000);
      }
    }
    void refresh();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [tenantId, revision, onActive]);

  const active = setup?.lifecycleStatus === "ACTIVE";
  const blocked = setup?.status === "BLOCKED";
  const failed = setup?.status === "FAILED";
  const steps = ["RELEASE", "ALLOCATE", "DEPLOY", "VALIDATE", "DONE"];
  const deploymentSteps = ["DATABASE", "MIGRATE", "SERVICES", "BOOTSTRAP", "INGRESS"];
  const visibleStep = deploymentSteps.includes(setup?.step ?? "") ? "DEPLOY" : setup?.step;
  const current = steps.indexOf(visibleStep ?? "RELEASE");
  return <section className="provisioning-panel" aria-label="Store setup status">
    <div className="provisioning-heading"><h3>{active ? "Your store is ready" : "Store setup"}</h3>
      <span className={`setup-badge ${active ? "ready" : ""}`}>{active ? "Active" : failed ? "Needs review" : blocked ? "Waiting for setup" : "In progress"}</span>
    </div>
    <ol className="provisioning-progress" aria-label="Provisioning progress">
      {["Prepare", "Allocate", "Deploy", "Check", "Ready"].map((label, i) => <li key={label} className={i <= current ? "reached" : ""} aria-current={i === current ? "step" : undefined}><span aria-hidden="true">{i < current ? "✓" : i + 1}</span>{label}</li>)}
    </ol>
    <p role="status">{error ? "We couldn’t refresh your setup status. Your payment remains recorded. Try again shortly." : !setup ? "Checking your store setup…" : active
      ? "Your storefront and store admin are ready. Your service period has started."
      : failed ? "Your setup needs a review by Rocento. Contact Rocento with your store address; you do not need to pay again."
      : blocked && setup.reason === "APPROVED_RELEASE_REQUIRED" ? "Your selected storefront is awaiting approval. Your payment is confirmed, and setup will continue when it’s ready."
      : blocked ? "Rocento needs to complete a setup prerequisite before your store can launch. Your payment remains confirmed."
      : setup.status === "RETRY" ? "Setup is taking longer than expected. We’ll retry automatically; you do not need to pay again."
      : "Your payment is confirmed. We’re working through the store setup checks."}</p>
    {active && <>
      {setup.serviceEndsAt && <p className="hint">Service coverage ends {new Date(setup.serviceEndsAt).toLocaleDateString()}.</p>}
      <div className="save-actions">
        {setup.storefrontUrl && <a className="primary" href={setup.storefrontUrl} target="_blank" rel="noopener noreferrer">Open storefront <span aria-hidden="true">↗</span></a>}
        {setup.adminUrl && <a className="back" href={setup.adminUrl} target="_blank" rel="noopener noreferrer">Open store admin</a>}
      </div>
    </>}
    {!active && <button className="back" onClick={() => setRevision(v => v + 1)}>Refresh setup status</button>}
  </section>;
}
