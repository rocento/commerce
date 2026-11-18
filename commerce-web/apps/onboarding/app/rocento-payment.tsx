"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, message } from "./client";

type Payment = {
  id: string;
  tenantId: string;
  method: "ROCENTO";
  amountMinor: number;
  currency: string;
  serviceDays: number;
  serviceMonths?: number | null;
  instructions: string;
  status: "AWAITING_PAYMENT" | "CONFIRMED" | "EXPIRED";
  expiresAt: string;
};

export function RocentoPayment({ draftId, tenantId, onConfirmed, storeActive = false }: {
  draftId: string;
  tenantId: string;
  onConfirmed: (confirmed: boolean) => void;
  storeActive?: boolean;
}) {
  const [payment, setPayment] = useState<Payment | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [months, setMonths] = useState(1);
  const [code, setCode] = useState("");
  const mounted = useRef(false);
  const [now, setNow] = useState(Date.now);
  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ items: Payment[] }>("billing/payment-requests");
      if (!mounted.current) return;
      const current = result.items.find((item) => item.tenantId === tenantId) ?? null;
      setPayment(current);
      onConfirmed(current?.status === "CONFIRMED");
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [tenantId, onConfirmed]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [refresh]);

  async function requestPayment() {
    setBusy(true);
    setError("");
    try {
      const result = await api<Payment>(`onboarding/drafts/${draftId}/payment-request`, "POST", { serviceMonths: months });
      if (!mounted.current) return;
      setPayment(result);
      onConfirmed(result.status === "CONFIRMED");
    } catch (cause) {
      if (mounted.current) setError(message(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  async function redeem() {
    if (!payment) return;
    setBusy(true); setError("");
    try {
      const result = await api<Payment>(`billing/payment-requests/${payment.id}/redeem`, "POST", { code });
      if (!mounted.current) return;
      setPayment(result); setCode(""); onConfirmed(result.status === "CONFIRMED");
    } catch (cause) { if (mounted.current) setError(message(cause)); }
    finally { if (mounted.current) setBusy(false); }
  }

  const status = payment?.status === "AWAITING_PAYMENT" && new Date(payment.expiresAt).getTime() <= now
    ? "EXPIRED" : payment?.status;
  return <section aria-label="Rocento payment" className="notice">
    <h3>Payment method: Rocento</h3>
    {payment ? <>
      <p><strong>{new Intl.NumberFormat(undefined, { style: "currency", currency: payment.currency }).format(payment.amountMinor / 100)}</strong>
        {" · "}{payment.serviceMonths ? `${payment.serviceMonths} calendar month${payment.serviceMonths === 1 ? "" : "s"}` : `${payment.serviceDays} service days`}</p>
      <p>Payment reference: <code style={{ overflowWrap: "anywhere" }}>{payment.id}</code></p>
      {status === "AWAITING_PAYMENT" && <>
        <p role="status">Pay offline, then enter the code Rocento sends you.</p>
        <p style={{ whiteSpace: "pre-wrap" }}>{payment.instructions}</p>
        <p>Valid until {new Date(payment.expiresAt).toLocaleString()}. Redeem your code before this reservation expires.</p>
        <form onSubmit={(event) => { event.preventDefault(); void redeem(); }}>
          <label>Six-digit payment code<input aria-label="Six-digit payment code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, ""))} required /></label>
          <button className="primary" disabled={busy || code.length !== 6}>{busy ? "Checking…" : "Confirm payment code"}</button>
        </form>
      </>}
      {status === "CONFIRMED" && <p role="status">{storeActive ? "Payment confirmed. Your store is active; see your service coverage below." : "Payment confirmed. Store setup is pending. Your service days begin when the store is activated."}</p>}
      {status === "EXPIRED" && <p role="status">This payment request has expired. Do not pay against it. Contact Rocento if you already paid.</p>}
      <button className="back" disabled={busy} onClick={() => void refresh()}>Refresh payment status</button>
    </> : <>
      <p>Pay Rocento offline. After verifying payment, Rocento will send you a six-digit code to continue setup.</p>
      <label>Billing period<select value={months} onChange={(event) => setMonths(Number(event.target.value))} disabled={busy}><option value={1}>Monthly · 1 month</option><option value={12}>Yearly · 12 months, no discount</option></select></label>
      <button className="primary" disabled={busy} onClick={requestPayment}>{busy ? "Loading payment…" : "Request Rocento payment"}</button>
    </>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
