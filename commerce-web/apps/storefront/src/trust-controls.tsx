import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cartApi, type components } from "@commerce/api-client";

type Proposal = Awaited<ReturnType<typeof cartApi.proposal>>;
const scopeLabel = { "cart.read": "Read this cart", "cart.propose": "Prepare basket proposals", "cart.apply": "Apply a confirmed basket", "order.place": "Place orders", "payment.authorize": "Authorize payments", "order.refund": "Issue refunds" };
const stateLabel = { proposed: "Ready for review", authorized: "Awaiting approved update", executing: "Updating cart", committed: "Cart updated", rejected: "Not approved", expired: "Approval expired", failed: "Cart update failed", indeterminate: "Outcome needs checking", reconciled: "Outcome verified", compensated: "Reversal completed", closed: "Closed" };
export function TrustControls({ proposal }: { proposal: Proposal }) {
  const history = useQuery({ queryKey: ["cart-trust", proposal.id, proposal.applied], queryFn: cartApi.trust, retry: false });
  const capabilities = useQuery({ queryKey: ["trust-capabilities"], queryFn: cartApi.trustCapabilities, enabled: history.data?.enabled === true, retry: false });
  const [agent, setAgent] = useState("");
  const [limit, setLimit] = useState(proposal.after.merchandise_total);
  const [apply, setApply] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  if (!history.data?.enabled) return null;
  async function act(work: () => Promise<unknown>, success: string) {
    setBusy(true); setMessage("");
    try { await work(); await history.refetch(); setMessage(success); }
    catch { setMessage("The request could not be verified. Refresh the history before retrying."); }
    finally { setBusy(false); }
  }
  const data = history.data;
  const selectedAgent = capabilities.data?.agents.find(a => a.id === agent);
  const scopes: components["schemas"]["TrustGrantInput"]["allowed_scopes"] = (["cart.read", "cart.propose"] as const).filter(scope => selectedAgent?.allowed_scopes.includes(scope));
  if (apply && selectedAgent?.allowed_scopes.includes("cart.apply")) scopes.push("cart.apply");
  return <details className="shopping-full-cart"><summary>Agent permissions and action history</summary>
    <p>Each approval covers one reviewed cart update, its items, quantities, currency and delivery terms. It cannot place an order, charge a payment, issue a refund or start a subscription. Permissions expire within 15 minutes and can be revoked here.</p>
    <button className="secondary" disabled={busy} onClick={() => void act(async () => {
      for (const action of data.actions.filter(a => ["authorized", "executing", "indeterminate"].includes(a.state))) await cartApi.actionStatus(action.id);
    }, "History refreshed.")}>Refresh permission history</button>
    {message && <p role="status">{message}</p>}
    {capabilities.data?.enabled && capabilities.data.agents.length > 0 && <fieldset disabled={busy}><legend>Allow a registered agent to help with this cart</legend>
      <label>Registered agent<select value={agent} onChange={e => { setAgent(e.target.value); setApply(false); }}><option value="">Choose an agent</option>{capabilities.data.agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label>Maximum merchandise value in {proposal.after.currency}<input type="number" min="0" step="0.01" value={limit} onChange={e => setLimit(e.target.value)} /></label>
      <label><input type="checkbox" disabled={!selectedAgent?.allowed_scopes.includes("cart.apply")} checked={apply} onChange={e => setApply(e.target.checked)} />Allow one cart update, only after I separately confirm its proposal</label>
      <p>{scopes.map(s => scopeLabel[s]).join(", ") || "Choose an agent to see its supported permissions"}. Access covers this cart and its reviewed products for 5 minutes. Signing out also ends this permission.</p>
      <button disabled={!agent || !scopes.length} onClick={() => void act(() => cartApi.grant({ agent_id: agent, allowed_scopes: scopes, denied_scopes: ["order.place", "payment.authorize", "order.refund"], product_ids: proposal.resulting_items.map(i => i.product_id), category_ids: [], location_id: proposal.draft.location_id, max_amount: limit, max_total: limit, currency: proposal.after.currency, max_actions: 1, duration_seconds: 300 }), "Permission created. Each cart update still needs your confirmation.")}>Grant limited permission</button>
    </fieldset>}
    <ul>{data.grants.map(g => {
      const active = !g.revoked_at && Date.parse(g.expires_at) > Date.now();
      const name = g.channel === "browser" ? "Rocento shopping assistant" : capabilities.data?.agents.find(a => a.id === g.agent_id)?.name ?? "Registered agent";
      return <li key={g.id}><strong>{name}</strong> · {g.allowed_scopes.map(s => scopeLabel[s]).join(", ")} · up to {g.max_amount} {g.currency} per update · {g.used_actions}/{g.max_actions} updates · {g.revoked_at ? "Revoked" : `Expires ${new Date(g.expires_at).toLocaleTimeString()}`}
        {active && <button className="secondary" disabled={busy} onClick={() => void act(() => cartApi.revokeGrant(g.id), "Permission revoked. Already committed updates remain in your cart.")}>Revoke permission</button>}
        {active && g.channel === "signed_http" && g.allowed_scopes.includes("cart.apply") && !proposal.applied && <button disabled={busy || !proposal.can_apply || Date.parse(proposal.expires_at) <= Date.now()} onClick={() => void act(() => cartApi.confirmProposal(proposal.id, proposal.id, g.id), "This exact proposal is confirmed for the selected agent. Check action history for its outcome.")}>Confirm reviewed proposal for {name}</button>}
      </li>;
    })}</ul>
    <ul aria-label="Agent action history">{data.actions.map(a => <li key={a.id}>Cart update · {a.amount} {a.currency} · <strong>{stateLabel[a.state]}</strong> · {new Date(a.confirmed_at).toLocaleString()} · Reference {a.id}</li>)}</ul>
  </details>;
}
