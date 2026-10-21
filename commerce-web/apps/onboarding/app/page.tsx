"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, message, ApiError } from "./client";
import { themes, plans } from "../lib/catalog";
import { hostnames, normalizeSlug } from "../lib/slug";
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
  payment: "PADDLE",
};
const steps = [
  "Your brand",
  "Your plan",
  "Storefront theme",
  "Review & reserve",
];
export default function Page() {
  const [draft, setDraft] = useState<Draft>(initial),
    [step, setStep] = useState(0),
    [ready, setReady] = useState(false),
    [error, setError] = useState(""),
    [accountReady, setAccountReady] = useState(false),
    [account, setAccount] = useState<Account | null>(null),
    [draftId, setDraftId] = useState<string | null>(null),
    [reserved, setReserved] = useState(false),
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
        setDraft(raw);
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
        setReservationExpiresAt(remote.reservation_expires_at ?? null);
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
    if (!ready || !accountReady || !account || !draftId) return;
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
      if (draftIdRef.current) {
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
        tenant: { slug_reserved_until: string };
      }>(`onboarding/drafts/${draftId}/reserve`, "POST", {
        version: versionRef.current,
      });
      versionRef.current = result.draft.version;
      setReserved(true);
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
    !!reservationExpiresAt &&
    new Date(reservationExpiresAt).getTime() <= Date.now();
  const reservationDeadline = reservationExpiresAt
    ? new Date(reservationExpiresAt).toLocaleString()
    : null;
  return (
    <div className="shell">
      <aside>
        <a className="wordmark" href="/">
          rocento<span>®</span>
        </a>
        <div className="journey">
          <span className="eyebrow">YOUR NEXT CHAPTER</span>
          <h1>
            A store that
            <br />
            feels like you.
          </h1>
          <p>
            Your brand. Your storefront.
            <br />
            One connected commerce platform.
          </p>
        </div>
        <nav aria-label="Setup progress">
          {steps.map((label, i) => (
            <button
              key={label}
              className={`step ${i === step ? "current" : ""}`}
              onClick={() => {
                if (i < step) {
                  setStep(i);
                  setError("");
                }
              }}
              disabled={i > step}
            >
              <span>{i < step ? "✓" : `0${i + 1}`}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="dot" /> LOCAL DEVELOPMENT PREVIEW
          <p>
            {account
              ? "Your draft syncs to your Rocento account."
              : "Your draft stays in this browser until you sign in."}
          </p>
        </div>
      </aside>
      <main>
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
                <strong>Save your setup across devices</strong>
                <p>
                  {accountReady
                    ? syncError ||
                      "Sign in or create an account to sync your draft."
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
        <header>
          <span>LET’S BUILD SOMETHING YOURS</span>
          <span>Step {step + 1} of 4</span>
        </header>
        <section className="content">
          <span className="eyebrow">
            {
              [
                "THE FOUNDATION",
                "ROOM TO GROW",
                "MAKE IT YOURS",
                "ONE LAST LOOK",
              ][step]
            }
          </span>
          <h2>
            {
              [
                "First, meet your brand.",
                "Find your starting point.",
                "Choose your storefront.",
                "Your store, at a glance.",
              ][step]
            }
          </h2>
          <p className="intro">
            {
              [
                "Give your store a name and a home on Rocento.",
                "Start with the space your business needs. Pricing is proposed and not yet available for purchase.",
                "Four existing Rocento demos. One shared commerce foundation.",
                "Review your setup. Reserve your store address after verifying your email. Checkout and store launch come later.",
              ][step]
            }
          </p>
          {step === 0 && (
            <div className="brand-form">
              <label htmlFor="brand">Brand name</label>
              <input
                id="brand"
                maxLength={100}
                placeholder="e.g. Tawheed"
                value={draft.brand}
                disabled={reserved}
                onChange={(e) =>
                  update({
                    brand: e.target.value,
                    slug: e.target.value
                      .trim()
                      .toLowerCase()
                      .replace(/\s+/g, "-"),
                  })
                }
              />
              <label htmlFor="slug">Store address</label>
              <div className="input-group">
                <input
                  id="slug"
                  maxLength={40}
                  placeholder="tawheed"
                  value={draft.slug}
                  disabled={reserved}
                  onChange={(e) => update({ slug: e.target.value })}
                />
                <span>.rocento.com</span>
              </div>
              <p className="hint">
                3–40 lowercase letters, numbers, or internal hyphens.
                Availability is confirmed when you reserve.
              </p>
              <div className="address-card">
                <div className="mini-icon">↗</div>
                <div>
                  <strong>Your own corner of the internet</strong>
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
                  Your storefront and admin addresses are reserved. Payment and
                  deployment are still unavailable.
                </p>
              ) : (
                <p className="notice">
                  Sign in and verify your email before reserving these
                  addresses.
                </p>
              )}
            </div>
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
                    {p.id === "ENTERPRISE" && <small>from </small>}$
                    {p.priceMinor / 100}
                    <small>/mo</small>
                  </span>
                  <span>
                    {p.id === "ENTERPRISE"
                      ? "A dedicated home for your business."
                      : p.id === "GROWTH"
                        ? "More room for your next chapter."
                        : "A thoughtful place to begin."}
                  </span>
                  <hr />
                  <span>
                    {p.maxTenants === 1
                      ? "Dedicated VM"
                      : "Shared pool · up to 3 stores / VM"}
                  </span>
                  <small>Subject to measured resource capacity</small>
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
                        Release mapping pending
                      </span>
                    </div>
                  </button>
                ))}
              </div>
              <p className="notice">
                These are the real demo categories and artwork. Live preview
                URLs and approved release versions have not been configured.
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
                    {plan.name} · ${plan.priceMinor / 100}
                    {plan.id === "ENTERPRISE" ? "+" : ""}/mo (proposed)
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
                {reserved
                  ? reservationExpired
                    ? `Your 24-hour address reservation ended ${reservationDeadline}. Refresh to check availability and reserve again. Your store has not launched.`
                    : `Setup saved. Your storefront and admin addresses are reserved until ${reservationDeadline ?? "the recorded expiry"}. Checkout and store launch are not available in this phase.`
                  : "Your draft is saved. After email verification, you can reserve these addresses for 24 hours. Checkout and store launch are not available in this phase."}
              </div>
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
                <button className="primary" onClick={next}>
                  Continue <span>→</span>
                </button>
              ) : reserved ? (
                <button className="primary" disabled>
                  {reservationExpired
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
        <div className="bottom-note">
          BUILT FOR YOUR BUSINESS. READY FOR YOUR NEXT CHAPTER.
        </div>
      </main>
    </div>
  );
}
