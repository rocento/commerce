"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import rocentoLogo from "../../../packages/ui/src/brand/rocento-logo-320.webp";
import { api, message, ApiError } from "./client";
import { themes, plans } from "../lib/catalog";
import { hostnames, normalizeSlug } from "../lib/slug";
import { RocentoPayment } from "./rocento-payment";
import { ActiveStore } from "./active-store";
import { ProvisioningStatus } from "./provisioning-status";
type Draft = {
  brand: string;
  slug: string;
  plan: string;
  theme: string;
  payment: string;
};
type Account = { id: string; email: string; verified: boolean; orgId: string };
type RemoteDraft = Draft & {
  id: string;
  version: number;
  tenant_id: string | null;
  reservation_expires_at?: string | null;
};
const initial: Draft = {
  brand: "",
  slug: "",
  plan: "LAUNCH",
  theme: "",
  payment: "ROCENTO",
};
function suggestedSlug(brand: string) {
  return brand.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)
    .replace(/^-+|-+$/g, "");
}

const steps = [
  "Your brand",
  "Your plan",
  "Storefront theme",
  "Review & reserve",
];
const stepDescriptions = ["Name & store address", "A plan for your business", "The look of your store", "Details & payment"];
export default function Page() {
  const [draft, setDraft] = useState<Draft>(initial),
    [step, setStep] = useState(0),
    [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [accountReady, setAccountReady] = useState(false),
    [account, setAccount] = useState<Account | null>(null),
    [draftId, setDraftId] = useState<string | null>(null),
    [reserved, setReserved] = useState(false),
    [tenantId, setTenantId] = useState<string | null>(null),
    [paymentConfirmed, setPaymentConfirmed] = useState(false),
    [storeActive, setStoreActive] = useState(false),
    [storeChecked, setStoreChecked] = useState(false),
    [reservationExpiresAt, setReservationExpiresAt] = useState<string | null>(
      null,
    ),
    [saving, setSaving] = useState(false),
    [syncError, setSyncError] = useState(""),
    [reserveBusy, setReserveBusy] = useState(false),
    [accountNotice, setAccountNotice] = useState("");
  const draftIdRef = useRef<string | null>(null);
  const versionRef = useRef(0);
  const draftRef = useRef(draft);
  const skipNextSave = useRef(false);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    try {
      const raw = JSON.parse(
        localStorage.getItem("rocento-draft-v1") ?? "null",
      );
      if (raw && Object.keys(initial).every((k) => typeof raw[k] === "string"))
        setDraft({ ...raw, payment: "ROCENTO" });
    } catch {}
    setReady(true);
  }, []);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);
  useEffect(() => {
    if (!ready) return;
    const key = account ? `rocento-draft-${account.id}` : "rocento-draft-v1";
    localStorage.setItem(key, JSON.stringify(draft));
    if (account) localStorage.removeItem("rocento-draft-v1");
  }, [draft, ready, account]);

  const enqueueSave = useCallback((snapshot: Draft) => {
    const operation = saveQueue.current.then(async () => {
      const id = draftIdRef.current;
      if (!id) throw new Error("DRAFT_NOT_READY");
      setSaving(true);
      setSyncError("");
      try {
        const saved = await api<RemoteDraft>(`onboarding/drafts/${id}`, "PUT", {
          ...snapshot,
          payment: "ROCENTO",
          version: versionRef.current,
        });
        versionRef.current = saved.version;
        return saved;
      } finally {
        setSaving(false);
      }
    });
    saveQueue.current = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }, []);

  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    (async () => {
      try {
        const current = await api<Account>("me");
        if (cancelled) return;
        setAccount(current);
        const remote = await api<RemoteDraft>("onboarding/draft");
        if (cancelled) return;
        const accountSaved = (() => {
          try {
            const raw = JSON.parse(
              localStorage.getItem(`rocento-draft-${current.id}`) ?? "null",
            );
            return raw &&
              Object.keys(initial).every((key) => typeof raw[key] === "string")
              ? (raw as Draft)
              : null;
          } catch {
            return null;
          }
        })();
        draftIdRef.current = remote.id;
        setDraftId(remote.id);
        versionRef.current = remote.version;
        const serverDraft: Draft = {
          brand: remote.brand,
          slug: remote.slug,
          plan: remote.plan,
          theme: remote.theme ?? "",
          payment: remote.payment,
        };
        const anonymousDraft = draftRef.current;
        const localDraft =
          anonymousDraft.brand.trim() ||
          anonymousDraft.slug ||
          anonymousDraft.theme
            ? anonymousDraft
            : (accountSaved ?? anonymousDraft);
        const localHasWork = !!(
          localDraft.brand.trim() ||
          localDraft.slug ||
          localDraft.theme
        );
        const serverIsBlank =
          remote.version === 0 &&
          !remote.tenant_id &&
          !remote.brand &&
          !remote.slug;
        if (serverIsBlank && localHasWork) {
          skipNextSave.current = false;
          setDraft(localDraft);
        } else {
          skipNextSave.current = true;
          setDraft(serverDraft);
        }
        setReserved(!!remote.tenant_id);
        setTenantId(remote.tenant_id);
        setReservationExpiresAt(remote.reservation_expires_at ?? null);
        if (remote.tenant_id) {
          const status = await api<{lifecycleStatus:string;status:string|null}>(`stores/${remote.tenant_id}/provisioning`);
          if (cancelled) return;
          setStoreActive(status.lifecycleStatus === "ACTIVE");
          setStoreChecked(true);
          setStep(3);
        }
      } catch (cause) {
        if (!(cause instanceof ApiError && cause.status === 401)) {
          setSyncError(message(cause));
        }
      } finally {
        if (!cancelled) setAccountReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready]);

  useEffect(() => {
    if (!ready || !accountReady || !account || !draftId || reserved) return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    if (saveTimer.current) clearTimeout(saveTimer.current);
    const snapshot = { ...draft };
    setSaving(true);
    saveTimer.current = setTimeout(() => {
      enqueueSave(snapshot).catch((cause) => setSyncError(message(cause)));
    }, 500);
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
    };
  }, [draft, ready, accountReady, account, draftId, reserved, enqueueSave]);

  async function signOut() {
    let draftSaved = false;
    try {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (draftIdRef.current && !reserved) {
        try {
          await enqueueSave(draftRef.current);
          draftSaved = true;
        } catch (cause) {
          setSyncError(message(cause));
        }
      }
      await api("customer/auth/logout", "POST", {});
    } catch (cause) {
      setSyncError(message(cause));
      return;
    }
    if (account && draftSaved)
      localStorage.removeItem(`rocento-draft-${account.id}`);
    setAccount(null);
    setDraftId(null);
    draftIdRef.current = null;
    versionRef.current = 0;
    setReserved(false);
    setTenantId(null);
    setPaymentConfirmed(false);
    setStoreActive(false);
    setStoreChecked(false);
    setReservationExpiresAt(null);
    setDraft(initial);
  }

  async function resendVerification() {
    if (!account) return;
    setAccountNotice("");
    try {
      await api("customer/auth/request-verification", "POST", {
        identifier: account.email,
      });
      setAccountNotice(
        "If verification is still needed, a new link has been queued.",
      );
    } catch (cause) {
      setAccountNotice(message(cause));
    }
  }

  async function reserveAddress() {
    setError("");
    setAccountNotice("");
    if (!account) {
      window.location.assign("/account");
      return;
    }
    if (!draftId) {
      setError(
        syncError || "Your account draft is unavailable. Reload and try again.",
      );
      return;
    }
    if (!account.verified) {
      setError("Verify your email before reserving your store address.");
      return;
    }
    if (!draft.brand.trim()) {
      setError("Enter your brand name first.");
      setStep(0);
      return;
    }
    if (!draft.theme) {
      setError("Choose a storefront theme before reserving your address.");
      setStep(2);
      return;
    }
    setReserveBusy(true);
    try {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      await enqueueSave(draft);
      const result = await api<{
        draft: RemoteDraft;
        tenant: { id: string; slug_reserved_until: string };
      }>(`onboarding/drafts/${draftId}/reserve`, "POST", {
        version: versionRef.current,
      });
      versionRef.current = result.draft.version;
      setReserved(true);
      setTenantId(result.tenant.id);
      setStoreChecked(true);
      setReservationExpiresAt(result.tenant.slug_reserved_until);
      setError("");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setReserveBusy(false);
    }
  }
  function update(patch: Partial<Draft>) {
    setDraft((current) => {
      const updated = { ...current, ...patch };
      draftRef.current = updated;
      return updated;
    });
    if (account) setSaving(true);
    setError("");
  }
  function next() {
    try {
      if (step === 0) {
        if (!draft.brand.trim()) throw Error("Enter your brand name.");
        normalizeSlug(draft.slug);
      }
      if (step === 2 && !themes.some((t) => t.id === draft.theme))
        throw Error("Choose a storefront theme.");
      setError("");
      setStep(Math.min(3, step + 1));
    } catch (e) {
      const message = e instanceof Error ? e.message : "Check your details.";
      setError(
        message === "RESERVED_SLUG"
          ? "This address is reserved. Please choose another."
          : message === "INVALID_SLUG"
            ? "Use 3–40 lowercase letters, numbers, or internal hyphens."
            : message,
      );
    }
  }
  let urls: ReturnType<typeof hostnames> | null = null;
  try {
    urls = hostnames(draft.slug);
  } catch {}
  const selected = themes.find((t) => t.id === draft.theme),
    plan = plans.find((p) => p.id === draft.plan) ?? plans[0];
  const reservationExpired =
    reserved &&
    !paymentConfirmed &&
    !!reservationExpiresAt &&
    new Date(reservationExpiresAt).getTime() <= Date.now();
  const reservationDeadline = reservationExpiresAt
    ? new Date(reservationExpiresAt).toLocaleString()
    : null;
  if (!accountReady) return <main className="store-loading"><p role="status">Loading your workspace…</p></main>;
  if (account && tenantId && !storeChecked) return <main className="store-loading">
    <h1>We couldn’t load your store</h1><p role="alert">{syncError || "Please try again."}</p>
    <button className="primary" onClick={() => window.location.reload()}>Try again</button>
    <button className="back" onClick={() => void signOut()}>Sign out</button>
  </main>;
  if (account && storeActive && tenantId) return <ActiveStore
    tenantId={tenantId} brand={draft.brand} slug={draft.slug} email={account.email}
    plan={plan.name} theme={selected?.name ?? draft.theme} onSignOut={signOut} signOutError={syncError}
  />;
  return (
    <div className="shell">
      <div className="setup-topbar">
        <a className="wordmark" href="/" aria-label="Rocento onboarding home">
          <img src={rocentoLogo.src} alt="Rocento" width="320" height="77" />
        </a>
        <span className="topbar-divider" />
        <span className="workspace-label">Commerce workspace</span>
        <div className="topbar-meta">
          {process.env.NEXT_PUBLIC_ONBOARDING_ENV === "test" && <span className="environment-badge">Test environment</span>}
          <span className="topbar-product">Store setup</span>
          {account ? (
            reserved && <button className="topbar-account-action" onClick={() => {
              setStep(3);
              setError("");
              document.getElementById("main-content")?.scrollIntoView({ behavior: "smooth" });
            }}>Track onboarding</button>
          ) : (
            <a className="topbar-account-action" href="/account">Sign in</a>
          )}
        </div>
      </div>
      <div className="setup-layout">
      <aside className="setup-sidebar">
        <div className="sidebar-heading"><span className="eyebrow">GET STARTED</span><h2>Your store starts here.</h2><p>Four steps to shape your next storefront.</p></div>
        <nav aria-label="Setup progress">
          {steps.map((label, i) => (
            <button
              key={label}
              className={`step ${i === step ? "current" : ""} ${i < step ? "complete" : ""}`}
              aria-current={i === step ? "step" : undefined}
              onClick={() => {
                if (i < step) {
                  setStep(i);
                  setError("");
                }
              }}
              disabled={i > step}
            >
              <span className="step-number" aria-hidden="true">{i < step ? "✓" : `${i + 1}`}</span>
              <span className="step-copy"><strong>{label}</strong><small>{stepDescriptions[i]}</small></span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom"><div className="progress-caption"><span>Setup progress</span><strong>{step + 1} / 4</strong></div><div className="progress-track"><span style={{width: `${(step + 1) * 25}%`}} /></div><p>You can review your choices before reserving your store address.</p></div>
      </aside>
      <main className="setup-main" id="main-content">
        <header className="workspace-header"><span>Workspace <span aria-hidden="true">/</span> <strong>New store</strong></span><span>Step {step + 1} of 4</span></header>
        <div className="account-bar">
          {account ? (
            <>
              <div>
                <strong>{account.email}</strong>
                <p aria-live="polite">
                  {account.verified
                    ? saving
                      ? "Saving your account draft…"
                      : syncError || "Your draft syncs to your account."
                    : "Verify your email before reserving your address."}
                </p>
              </div>
              {!account.verified && (
                <button className="back" onClick={resendVerification}>
                  Resend verification
                </button>
              )}
              <button
                className="back"
                disabled={saving || reserveBusy}
                onClick={signOut}
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <div>
                <strong>Start now. Create your account later.</strong>
                <p>
                  {accountReady
                    ? syncError ||
                      "Explore your setup without signing in. Your draft is saved on this device."
                    : "Checking your account…"}
                </p>
              </div>
              <a className="account-link" href="/account">
                Sign in or create an account
              </a>
            </>
          )}
          {accountNotice && <p role="status">{accountNotice}</p>}
        </div>
        <div className="workspace-body">
        <section className="content">
          <span className="eyebrow">
            {
              [
                "01 / BRAND DETAILS",
                "02 / YOUR PLAN",
                "03 / STOREFRONT DESIGN",
                "04 / REVIEW & RESERVE",
              ][step]
            }
          </span>
          <h1>
            {
              [
                "Make it your business.",
                "Choose room to grow.",
                "Find your storefront.",
                "Everything in place.",
              ][step]
            }
          </h1>
          <p className="intro">
            {
              [
                "Start with your brand name and a store address. You’ll review everything before reserving.",
                "Select a starting point for your business. Prices below are indicative; your Rocento payment request will show the confirmed terms.",
                "Choose a starting design that fits your catalog. Each option includes a storefront and store admin.",
                "Check your brand, plan, design, and address. Reservation and payment are the next steps.",
              ][step]
            }
          </p>
          {step === 0 && (
            <form id="brand-details" className="brand-form" onSubmit={(event) => { event.preventDefault(); next(); }}>
              <label htmlFor="brand">Brand name</label>
              <input
                id="brand"
                autoComplete="organization"
                maxLength={100}
                placeholder="e.g. Rocento"
                value={draft.brand}
                disabled={reserved}
                onChange={(e) =>
                  update({
                    brand: e.target.value,
                    slug: !draft.slug || draft.slug === suggestedSlug(draft.brand)
                      ? suggestedSlug(e.target.value)
                      : draft.slug,
                  })
                }
              />
              <label htmlFor="slug">Store address</label>
              <div className="input-group">
                <input
                  id="slug"
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={40}
                  placeholder="rocento"
                  value={draft.slug}
                  disabled={reserved}
                  onChange={(e) => update({ slug: e.target.value.toLowerCase().replace(/\s+/g, "-") })}
                />
                <span>.rocento.com</span>
              </div>
              <p className="hint">
                3–40 lowercase letters, numbers, or internal hyphens.
                Availability is confirmed when you reserve.
              </p>
              <div className="address-card">
                <div className="mini-icon" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M7 6.5h1m2 0h1"/></svg></div>
                <div>
                  <strong>Your connected workspace</strong>
                  <p>
                    Storefront{" "}
                    <span>{urls?.storefront ?? "your-brand.rocento.com"}</span>
                  </p>
                  <p>
                    Store admin{" "}
                    <span>{urls?.admin ?? "your-brand-admin.rocento.com"}</span>
                  </p>
                </div>
              </div>
              {reserved ? (
                <p className="notice" role="status">
                  {storeActive ? "Your storefront and store admin are active. Open them from the final step." : "Your storefront and admin addresses are reserved. Review your Rocento payment in the final step. Store launch is pending."}
                </p>
              ) : (
                <p className="notice">
                  Your addresses are reserved only after you sign in and verify your email.
                </p>
              )}
            </form>
          )}
          {step === 1 && (
            <div className="plans">
              {plans.map((p) => (
                <button
                  className={`plan ${draft.plan === p.id ? "selected" : ""}`}
                  key={p.id}
                  onClick={() => update({ plan: p.id })}
                  disabled={reserved}
                  aria-pressed={draft.plan === p.id}
                >
                  <span className="plan-top">
                    {p.name}
                    <span className="radio" />
                  </span>
                  <span className="price">
                    $
                    {(p.priceMinor / 100).toLocaleString("en-US")}
                    <small>/mo</small>
                  </span>
                  <span className="plan-caption">Indicative pricing</span>
                  <strong>0% Transaction Commission.</strong>
                  <span>
                    {p.id === "ENTERPRISE"
                      ? "For a dedicated deployment."
                      : p.id === "GROWTH"
                        ? "For an expanding business."
                        : "For your first storefront."}
                  </span>
                  <hr />
                  <span>
                    {p.maxTenants === 1
                      ? "Dedicated environment"
                      : "Shared environment"}
                  </span>
                  <small>Storefront & store admin</small>
                </button>
              ))}
            </div>
          )}
          {step === 2 && (
            <>
              <div className="themes">
                {themes.map((t) => (
                  <button
                    className={`theme ${draft.theme === t.id ? "selected" : ""}`}
                    key={t.id}
                    onClick={() => update({ theme: t.id })}
                    disabled={reserved}
                    aria-pressed={draft.theme === t.id}
                  >
                    <img src={t.image} alt={`${t.name} demo artwork`} />
                    <div className="theme-body">
                      <span className="plan-top">
                        {t.name}
                        <span className="radio" />
                      </span>
                      <p>{t.description}</p>
                      <span className="theme-status">
                        Design preview
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              <p className="notice">
                These previews show the available design directions. Live store previews are not available yet.
              </p>
            </>
          )}
          {step === 3 && (
            <>
              <div className="review">
                <div>
                  <span>BRAND</span>
                  <strong>{draft.brand}</strong>
                </div>
                <div>
                  <span>PLAN</span>
                  <strong>
                    {plan.name}
                  </strong>
                </div>
                <div>
                  <span>STOREFRONT</span>
                  <strong>{selected?.name ?? "Not selected"}</strong>
                </div>
                <div>
                  <span>
                    ADDRESS · {reserved ? "RESERVED" : "NOT RESERVED"}
                  </span>
                  <strong>{urls?.storefront}</strong>
                </div>
              </div>
              <div className="notice" role={reserved ? "status" : undefined}>
                {storeActive ? "Your storefront and store admin are active."
                  : paymentConfirmed
                  ? "Rocento payment confirmed. Your store is awaiting setup."
                  : reserved
                  ? reservationExpired
                    ? `Your 24-hour address reservation ended ${reservationDeadline}. Refresh to check availability and reserve again. Your store has not launched.`
                    : `Setup saved. Your storefront and admin addresses are reserved until ${reservationDeadline ?? "the recorded expiry"}. You can now request Rocento offline payment. Store launch is pending.`
                  : "Your draft is saved. After email verification, reserve these addresses for 24 hours, then request Rocento offline payment. Store launch is pending."}
              </div>
              {account && draftId && tenantId && <RocentoPayment
                key={tenantId} draftId={draftId} tenantId={tenantId} onConfirmed={setPaymentConfirmed} storeActive={storeActive}
              />}
              {account && tenantId && paymentConfirmed && <ProvisioningStatus tenantId={tenantId} onActive={setStoreActive} />}
            </>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          <footer>
            <span>
              {!ready
                ? "Loading draft…"
                : !account
                  ? "Draft saved on this device"
                  : saving
                    ? "Saving account draft…"
                    : syncError || "Draft saved to your account"}
            </span>
            <div>
              {step > 0 && (
                <button
                  className="back"
                  onClick={() => {
                    setStep(step - 1);
                    setError("");
                  }}
                >
                  Back
                </button>
              )}
              {step < 3 ? (
                <button className="primary" type={step === 0 ? "submit" : "button"} form={step === 0 ? "brand-details" : undefined} onClick={step === 0 ? undefined : next}>
                  Continue <span aria-hidden="true">→</span>
                </button>
              ) : reserved ? (
                <button className="primary" disabled>
                  {storeActive ? "Store active" : paymentConfirmed
                    ? "Payment confirmed"
                    : reservationExpired
                    ? "Reservation expired"
                    : "Address reserved"}
                </button>
              ) : account ? (
                <button
                  className="primary"
                  disabled={reserveBusy || !accountReady || !draftId}
                  onClick={reserveAddress}
                >
                  {reserveBusy
                    ? "Reserving…"
                    : !draftId
                      ? "Draft unavailable"
                      : account.verified
                        ? "Reserve store address"
                        : "Verify email to reserve"}
                </button>
              ) : (
                <a className="primary" href="/account">
                  Sign in to reserve
                </a>
              )}
            </div>
          </footer>
        </section>
        <aside className="context-rail" aria-label="Your setup summary">
          <div className="preview-card">
            <div className="rail-heading"><span>YOUR STOREFRONT</span><span className="preview-badge">Preview</span></div>
            <div className="store-preview" aria-hidden="true">
              <div className="preview-browser"><i/><i/><i/><span>{urls?.storefront ?? "your-brand.rocento.com"}</span></div>
              <div className="preview-store-nav"><strong>{draft.brand || "Your brand"}</strong><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M5 7h14l1 14H4L5 7ZM9 8V6a3 3 0 0 1 6 0v2"/></svg></div>
              {selected ? <img className="preview-artwork" src={selected.image} alt=""/> : <div className="preview-art"><div className="art-orbit"/><span>A new<br/>perspective.</span><small>YOUR NEXT COLLECTION</small></div>}
              <div className="preview-products"><div/><div/><div/></div>
            </div>
            <p className="preview-caption">A first look at what’s next.<br/>Your store is not live yet.</p>
          </div>
          <div className="summary-card"><h2>At a glance</h2><dl><div><dt>Brand</dt><dd>{draft.brand || "Not set yet"}</dd></div><div><dt>Plan</dt><dd>{plan.name}</dd></div><div><dt>Design</dt><dd>{selected?.name || "Not selected"}</dd></div><div><dt>Payment</dt><dd>Rocento <span>Offline</span></dd></div></dl></div>
          <div className="rail-note"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg><p><strong>You’re in control.</strong>Review your setup before reservation. Rocento confirms offline payments manually.</p></div>
        </aside>
        </div>
        <div className="bottom-note">
          Rocento Commerce <span>·</span> Your next chapter starts here.
        </div>
      </main>
      </div>
    </div>
  );
}
