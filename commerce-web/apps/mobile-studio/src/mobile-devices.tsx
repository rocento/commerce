import { useEffect, useState } from "react";
import { mobileApi, type MobileMerchant } from "@commerce/api-client";

export function MobileDevices({ merchant }: { merchant: MobileMerchant }) {
  const [identities, setIdentities] = useState<Awaited<ReturnType<typeof mobileApi.nativeIdentities>>>([]);
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof mobileApi.devices>>>([]);
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (merchant.role !== "owner") return;
    const controller = new AbortController();
    Promise.all([mobileApi.nativeIdentities(merchant.id, controller.signal), mobileApi.devices(merchant.id, controller.signal)])
      .then(([identities, devices]) => { if (!controller.signal.aborted) { setIdentities(identities); setDevices(devices); } })
      .catch((e: Error) => { if (!controller.signal.aborted) setError(e.message); });
    return () => controller.abort();
  }, [merchant.id, merchant.role, refresh]);
  useEffect(() => {
    if (!code) return;
    const timer = window.setTimeout(() => setCode(""), 900000);
    return () => window.clearTimeout(timer);
  }, [code]);
  if (merchant.role !== "owner") return <p>Only the merchant owner can connect or revoke internal test installations.</p>;
  async function invite(id: string) {
    setBusy(true); setError(""); setCode("");
    try { setCode((await mobileApi.inviteDevice(merchant.id, id)).code); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not create a connection code."); }
    finally { setBusy(false); }
  }
  async function revoke(id: string) {
    setBusy(true); setError("");
    try { await mobileApi.revokeDevice(merchant.id, id); setRefresh(v => v + 1); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not revoke this installation."); }
    finally { setBusy(false); }
  }
  return <div className="ms-fields">
    <p>Connect an internal test installation to the production design. Codes expire after 15 minutes and work once. In the app, open Account → App connection.</p>
    {error && <p className="ms-error" role="alert">{error}</p>}
    {!identities.length && <p>No production app identities have been provisioned yet.</p>}
    {identities.map(i => <div key={i.id}><strong>{i.platform === "ios" ? "iOS" : "Android"}</strong><p>{i.identifier}</p><button disabled={busy} onClick={() => void invite(i.id)}>Create {i.platform === "ios" ? "iOS" : "Android"} connection code</button></div>)}
    {code && <label className="ms-field"><span>One-time connection code — keep private</span><input aria-label="One-time connection code" readOnly value={code} autoComplete="off" spellCheck={false} onFocus={e => e.target.select()} /><button onClick={() => setCode("")}>Hide code</button></label>}
    <h3>Connected installations</h3>
    <button disabled={busy} onClick={() => setRefresh(v => v + 1)}>Refresh installations</button>
    <p>Revocation stops future design and asset downloads. Customer sign-in is managed separately. Previously downloaded designs can remain available offline.</p>
    {devices.length === 0 && <p>No connected installations.</p>}
    {devices.map(d => <div key={d.id}><strong>{d.platform === "ios" ? "iOS" : "Android"}</strong><p>{d.id}</p><p>Connected {new Date(d.createdAt).toLocaleString()} · Expires {new Date(d.expiresAt).toLocaleString()}</p>{d.revokedAt ? <p>Revoked</p> : <button disabled={busy} onClick={() => void revoke(d.id)}>Revoke installation</button>}</div>)}
  </div>;
}
