import { ReorderAlternatives } from "./reorder-alternatives";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, cartApi, mediaUrl, type components } from "@commerce/api-client";
import { useCart } from "./cart";
import { setDeliveryPin } from "@commerce/api-client";
import "./shopping.css";
import { TrustControls } from "./trust-controls";

type Proposal = Awaited<ReturnType<typeof cartApi.proposal>>;
type Draft = components["schemas"]["BasketDraft"];
function ProposalFailure({ error, reload }: { error: unknown; reload?: () => void }) {
  const failure = error instanceof ApiError ? error.failure : undefined;
  return <div role="alert"><p>{failure ? `${failure.message} Reference: ${failure.request_reference}` : typeof error === "string" ? error : "The proposal request could not be completed. Check its status before trying again."}</p>
    {failure?.recovery === "sign_in" && <Link to="/login">Sign in</Link>}
    {failure?.recovery === "browse_catalog" && <Link to="/search">Browse catalog</Link>}
    {(!failure || failure.recovery === "refresh_proposal") && reload && <button onClick={reload}>Reload latest proposal</button>}
    {failure?.recovery === "contact_support" && <Link to="/support">Contact support</Link>}
  </div>;
}
function ProductImage({ product }: { product: Proposal["lines"][number]["product"] }) {
  const [failed, setFailed] = useState(false);
  return product?.media_ids[0] && !failed ? <img src={mediaUrl(product.media_ids[0])} alt={product.name} onError={() => setFailed(true)} /> : <span className="shopping-image-fallback">No image</span>;
}
function Totals({ totals, label }: { totals: Proposal["after"]; label: string }) {
  return <section className="shopping-totals" aria-label={label}><h4>{label}</h4><dl>
    {[["Merchandise", totals.subtotal], ["Discounts", totals.discount], ["Tax", totals.tax], ["Delivery", totals.delivery], ["Payable total", totals.payable]].map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value === null ? "Not yet verified" : `${value} ${totals.currency}`}</dd></div>)}
  </dl>{totals.promotions.map(name => <p key={name}>{name}</p>)}{!totals.payable && <p>Merchandise after discounts: {totals.merchandise_total} {totals.currency}. Total is incomplete.</p>}</section>;
}
export function BasketProposalCard({ id, onApplied }: { id: string; onApplied?: (cart: Awaited<ReturnType<typeof cartApi.open>>, locationId: string | null) => void }) {
  const q = useQuery({ queryKey: ["basket-proposal", id], queryFn: () => cartApi.proposal(id), retry: false });
  if (q.isPending) return <p role="status">Loading proposed basket…</p>;
  if (q.isError) return <><ProposalFailure error={q.error} />{(!(q.error instanceof ApiError) || q.error.failure?.retryable !== false) && <button onClick={() => void q.refetch()}>Retry proposal</button>}</>;
  return <ProposalEditor key={q.data.id} proposal={q.data} onApplied={onApplied} />;
}
function SavedGoal({ proposal, busy, onResume }: { proposal: Proposal; busy: boolean; onResume: (p: Proposal) => void }) {
  const task = proposal.draft.task_id;
  const goal = useQuery({ queryKey: ["execution-goal", task, proposal.id], queryFn: () => cartApi.executionGoal(task), retry: false });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<unknown>();
  async function act(resume: boolean) {
    if (!goal.data || working || busy) return;
    setWorking(true); setError(undefined);
    try {
      if (resume) onResume(await cartApi.resumeExecutionGoal(task, goal.data.receipt.revision));
      else await cartApi.saveExecutionGoal(task, goal.data.receipt.revision);
      await goal.refetch();
    } catch (e) { setError(e); await goal.refetch(); }
    finally { setWorking(false); }
  }
  const terminal = goal.data && ["completed", "cancelled", "expired"].includes(goal.data.receipt.state);
  return <section aria-label="Saved shopping goal">
    <p>Saved quote from {new Date(proposal.execution!.observed_at).toLocaleString()}. Resume checks current prices and availability before a new review.</p>
    {goal.isError && <ProposalFailure error={goal.error} />}
    {!!error && <ProposalFailure error={error} />}
    {goal.data && <>
      <p>{goal.data.saved_by_customer ? "Goal saved for this account or guest session, separately from chat." : "Save this goal to return to its selections and constraints later."} Expires {new Date(goal.data.goal_expires_at).toLocaleString()}.</p>
      {goal.data.receipt.state === "blocked" && <p role="status">Revalidation stopped. Review the unresolved constraints or start a new shopping task.</p>}
      {!terminal && (goal.data.saved_by_customer ? <button className="secondary" disabled={busy || working || goal.data.receipt.state === "blocked"} onClick={() => void act(true)}>Resume saved goal</button> : <button className="secondary" disabled={busy || working} onClick={() => void act(false)}>Save goal for later</button>)}
    </>}
  </section>;
}
function ProposalEditor({ proposal, onApplied }: { proposal: Proposal; onApplied?: (cart: Awaited<ReturnType<typeof cartApi.open>>, locationId: string | null) => void }) {
  const [p, setProposal] = useState(proposal);
  const [draft, setDraft] = useState(proposal.draft);
  const notified = useRef(false);
  useEffect(() => {
    if (!p.applied || !onApplied || notified.current) return;
    let active = true;
    void cartApi.open().then(cart => { if (active) { notified.current = true; onApplied(cart, p.draft.location_id); } }).catch(() => {});
    return () => { active = false; };
  }, [p.applied, p.draft.location_id, onApplied]);
  const [selected, setSelected] = useState(proposal.lines.map(l => l.selection.product_id));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState(false);
  const [actionId, setActionId] = useState<string>();
  async function checkStatus() {
    try {
      const history = await cartApi.trust();
      const id = actionId ?? history.actions.find(a => a.proposal_id === p.id)?.id;
      const action = id ? await cartApi.actionStatus(id) : undefined;
      const result = await cartApi.proposal(p.id);
      if (action?.state === "committed" || result.applied) { setProposal(result); setPending(false); await cache.invalidateQueries({ queryKey: ["cart"] }); }
      else if (action && ["failed", "expired", "rejected", "closed"].includes(action.state)) { setPending(false); setError("This approval did not change your cart. Requote and review fresh terms before confirming again."); }
      else { setError(action?.state === "authorized" ? "Your approval is recorded but the update has not committed. Revoke the approval below or check status again." : "The outcome is not yet verified. Check status again before making changes."); }
    } catch { setError("Status is still unavailable. Keep this proposal and check again later."); }
  }
  const lock = useRef(false);
  const [now, setNow] = useState(Date.now);
  const { setCart } = useCart();
  const cache = useQueryClient();
  const context = useQuery({ queryKey: ["shopping-task", p.draft.task_id], queryFn: () => cartApi.shoppingContext(p.draft.task_id) });
  const expired = now >= Date.parse(p.expires_at);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  function edit(next: Draft) { setDraft(next); setDirty(true); }
  async function requote(replacement?: Draft) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const latest = await cartApi.shoppingContext(draft.task_id);
      if (latest.task_revision !== draft.task_revision) { setError("This shopping task changed in another tab. Reload the latest proposal before editing."); return; }
      const next = await cartApi.propose({ ...(replacement ?? draft), auto_select: false, selections: replacement ? replacement.selections : draft.selections.filter(s => selected.includes(s.product_id)), source_revision: latest.source_revision, task_revision: latest.task_revision });
      setProposal(next); setDraft(next.draft); setSelected(next.lines.map(l => l.selection.product_id)); setDirty(false);
      await cache.invalidateQueries({ queryKey: ["shopping-task", draft.task_id] });
    } catch (e) { setError(e); }
    finally { lock.current = false; setBusy(false); }
  }
  async function apply() {
    if (lock.current || pending || dirty || expired || !p.can_apply || (p.draft.mode === "buy_again" && !p.draft.location_id) || p.applied || (p.execution && p.execution.verdict !== "pass")) return;
    lock.current = true; setBusy(true); setError(""); setPending(true);
    let confirmed = false;
    try {
      // The explicit approval click creates authority bound to these reviewed terms.
      const confirmation = await cartApi.confirmProposal(p.id, p.id);
      confirmed = true;
      setActionId(confirmation.action?.id);
      // A proposal can commit only once, even after refresh or a lost response.
      const cart = await cartApi.applyProposal(p.id, p.id);
      setCart(cart); setProposal({ ...p, applied: true }); setPending(false);
      const location = p.draft.location_id;
      if (location) {
        // Keep the delivery context in sync through the existing location selection flow at checkout.
        const { customerApi } = await import("@commerce/api-client");
        const saved = (await customerApi.locations()).find(l => l.id === location);
        if (saved) {
          setDeliveryPin({ latitude: saved.latitude, longitude: saved.longitude });
          if (cart.customer_id) {
            sessionStorage.setItem(`commerce-active-location:${cart.customer_id}`, saved.id);
            window.dispatchEvent(new Event("commerce-location"));
          }
        }
      }
      await Promise.allSettled([cache.invalidateQueries({ queryKey: ["cart"] }), cache.invalidateQueries({ queryKey: ["stock"] }), cache.invalidateQueries({ queryKey: ["catalog-search"] }), cache.invalidateQueries({ queryKey: ["shopping-task", draft.task_id] })]);
    } catch (e) {
      const result = await cartApi.proposal(p.id).catch(() => null);
      if (result?.applied) { setProposal(result); setPending(false); await cache.invalidateQueries({ queryKey: ["cart"] }); }
      else if (!confirmed && e instanceof ApiError && e.status < 500) { setPending(false); setError(e.message); }
      else { setError(e); await checkStatus(); }
    } finally { lock.current = false; setBusy(false); }
  }
  return <section className="shopping-proposal" aria-label="Proposed basket">
    <header><span className="shopping-badge">{p.applied ? "Verified cart update" : pending ? "Confirmation pending" : "Proposed basket"}</span><h3>{p.draft.goal.purpose || (p.draft.mode === "optimize" ? "Review cart improvements" : "Review your basket")}</h3><p>{p.applied ? "The approved changes were applied. Review checkout separately to place an order." : pending ? "The cart update is not yet confirmed. Check its status before making further changes." : "Your live cart has not changed. Review these changes before applying."}</p></header>
    {p.execution && !p.applied && <SavedGoal proposal={p} busy={busy || pending || dirty} onResume={fresh => { setProposal(fresh); setDraft(fresh.draft); setSelected(fresh.lines.map(l => l.selection.product_id)); setDirty(false); setPending(false); setError(undefined); void cache.invalidateQueries({ queryKey: ["shopping-task", draft.task_id] }); }} />}
    {!!error && <ProposalFailure error={error} reload={() => {
      if (lock.current) return;
      lock.current = true; setBusy(true);
      void cartApi.shoppingContext(draft.task_id).then(async latest => {
        if (!latest.proposal_id) return;
        const fresh = await cartApi.proposal(latest.proposal_id);
        setProposal(fresh); setDraft(fresh.draft); setSelected(fresh.lines.map(l => l.selection.product_id)); setDirty(false); setPending(false); setError(undefined);
      }).catch(setError).finally(() => { lock.current = false; setBusy(false); });
    }} />}
    {!p.applied && <fieldset disabled={busy || pending}><legend>Edit proposal</legend>
      <label>Delivery location<select value={draft.location_id ?? ""} onChange={e => edit({ ...draft, location_id: e.target.value || null })}><option value="">Current delivery context / not selected</option>{context.data?.locations.map(l => <option key={l.id} value={l.id}>{l.label}{l.is_default ? " (default)" : ""}</option>)}</select></label>
      {draft.mode === "buy_again" && !draft.location_id && <p role="status">Select a delivery location to check the full total and availability. <Link to="/account/locations/new" target="_blank" rel="noopener">Add a delivery location</Link>, then <button type="button" onClick={() => void context.refetch()}>Refresh saved locations</button>.</p>}
      <label>Requested delivery date<input type="date" value={draft.goal.delivery_date ?? ""} onChange={e => edit({ ...draft, goal: { ...draft.goal, delivery_date: e.target.value || null } })} /></label>
      <label>Budget in {p.after.currency}<input type="number" min="0" step="0.01" value={draft.goal.budget ?? ""} onChange={e => edit({ ...draft, goal: { ...draft.goal, budget: e.target.value || null, currency: p.after.currency } })} /></label>
      <label><input type="checkbox" checked={draft.goal.all_inclusive} onChange={e => edit({ ...draft, goal: { ...draft.goal, all_inclusive: e.target.checked } })} />Budget includes tax and delivery</label>
    </fieldset>}
    <ul className="shopping-lines">{p.lines.map(line => {
      const id = line.selection.product_id;
      const rule = p.market_facts?.[id]?.selling_rule;
      const s = draft.selections.find(v => v.product_id === id)!;
      const locked = draft.goal.locked_products.includes(line.selection.replaces ?? id);
      return <li key={id}><ProductImage product={line.product} /><div>
        <strong>{line.product ? <Link to={`/products/${id}`}>{line.product.name}</Link> : "Unavailable historical product"}</strong>
        {line.product && <><p>{line.product.price} {line.product.currency} per {rule ? "selling unit" : line.product.unit} · {line.available} available</p><p>SKU: {line.product.sku}</p><dl>{Object.entries({ ...line.product.attributes, ...line.product.variant_attributes }).slice(0, 8).map(([key, value]) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{typeof value === "string" ? value : JSON.stringify(value)}</dd></div>)}</dl></>}
        {rule && <p>Each selling unit contains {rule.measure_per_unit} {rule.measure_unit}. Minimum {rule.minimum} units; increment {rule.increment}.</p>}
        {line.previous && <p>Replaces {line.previous.name} at {line.previous.price} {line.previous.currency} per {line.previous.unit}; the verified total amount is preserved.</p>}
        {line.historical_price && <p>Previous order unit price: {line.historical_price}. Current unit price: {line.product?.price ?? "unavailable"}.</p>}
        <p>{line.selection.reason}</p>
        {!p.applied && <div className="shopping-line-controls">
          <label><input type="checkbox" disabled={busy || pending} checked={selected.includes(id)} onChange={e => { setSelected(values => e.target.checked ? [...values, id] : values.filter(v => v !== id)); setDirty(true); }} />Accept {line.previous ? "replacement" : "item"}</label>
          <label>Quantity<input aria-label={`Proposed quantity for ${line.product?.name ?? id}`} type="number" min={rule?.minimum ?? 1} max={rule?.maximum ?? 1000000} step={rule?.increment ?? 1} disabled={busy || pending || locked || p.draft.mode === "optimize"} value={s.quantity} onChange={e => edit({ ...draft, selections: draft.selections.map(v => v.product_id === id ? { ...v, quantity: Number(e.target.value) } : v) })} /></label>
          <label><input type="checkbox" checked={locked} disabled={busy || pending} onChange={e => { const key = line.selection.replaces ?? id; edit({ ...draft, goal: { ...draft.goal, locked_products: e.target.checked ? [...draft.goal.locked_products, key] : draft.goal.locked_products.filter(v => v !== key) } }); if (line.previous && e.target.checked) setSelected(values => values.filter(v => v !== id)); }} />Keep {line.previous ? "original product" : "this product"} unchanged</label>
        </div>}
        {draft.mode === "buy_again" && !p.applied && <ReorderAlternatives name={line.product?.name ?? "this item"} excluded={draft.selections.map(v => v.product_id)} busy={busy || pending} onChoose={product => {
          const replacement = { ...draft, selections: [...draft.selections.filter(v => v.product_id !== id && selected.includes(v.product_id)), { product_id: product.id, quantity: 1, replaces: null, required_attributes: {}, reason: `Explicitly selected alternative to ${(line.product?.name ?? "an unavailable historical item").slice(0, 200)}. Review pack size and quantity.` }] };
          void requote(replacement);
        }} />}
      </div></li>;
    })}</ul>
    {draft.goal.assumptions.length > 0 && <div><strong>Assumptions — please review</strong><ul>{draft.goal.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></div>}
    {p.delivery_check && <p>{p.delivery_check.available ? `Capacity was available for ${p.delivery_check.date} when checked. Choose and reserve a matching window at checkout; this proposal does not reserve delivery.` : `Delivery is unverified: ${p.delivery_check.reason.replaceAll("_", " ")}.`}</p>}
    {p.draft.goal.budget && <p>Budget: {p.draft.goal.budget_exclusive ? "below" : "up to"} {p.draft.goal.budget} {p.draft.goal.currency ?? p.after.currency}, {p.draft.goal.all_inclusive ? "including tax and delivery" : "merchandise after discounts"}.</p>}
    <details className="shopping-full-cart"><summary>Review all resulting cart items ({p.resulting_items.length})</summary><ul>{p.resulting_items.map(item => <li key={item.product_id}><strong>{item.name}</strong> · {item.quantity} {item.unit} × {item.price} {item.currency} = {item.line_total} {item.currency}</li>)}</ul></details>
    {p.draft.mode === "optimize" && <details className="shopping-full-cart"><summary>Original cart items ({p.current_items.length})</summary><ul>{p.current_items.map(item => <li key={item.product_id}>{item.name} · {item.quantity} {item.unit} · {item.line_total} {item.currency}</li>)}</ul></details>}
    <div className="shopping-comparison">{p.draft.mode === "optimize" && <Totals totals={p.before} label="Current cart" />}<Totals totals={p.after} label="Resulting cart quote" /></div>
    {p.savings && p.draft.mode === "optimize" && <p>Quoted savings: {p.savings} {p.after.currency}</p>}
    {p.issues.length > 0 && <div role="status"><strong>Unresolved constraints</strong><ul>{p.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul></div>}
    {p.notes.map((note, i) => <p className="shopping-note" key={i}>{note}</p>)}
    {p.applied ? <div className="shopping-actions"><Link className="primary-link" to="/checkout">Continue to checkout review</Link><Link to="/assistant">Start a new shopping task</Link></div> : <div className="shopping-actions">
      <p>{busy ? "Action in progress…" : dirty ? "Changes need a fresh quote before approval." : expired ? "Quote expired. Refresh it before applying." : `Quote valid until ${new Date(p.expires_at).toLocaleTimeString()}`}</p>
      <button className="secondary" disabled={busy || pending} onClick={() => void requote()}>Requote selected changes</button>
      <button disabled={busy || pending || dirty || expired || !p.can_apply || (p.draft.mode === "buy_again" && !p.draft.location_id) || (p.execution && p.execution.verdict !== "pass")} onClick={() => void apply()}>{pending ? "Awaiting verified outcome" : "Approve and apply to cart"}</button>
      {pending && <button className="secondary" disabled={busy} onClick={() => void checkStatus()}>Check action status</button>}
    </div>}
    <TrustControls proposal={p} />
  </section>;
}
