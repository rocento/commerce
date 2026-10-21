import { EntityIdHeading, EntityIdCell } from "./entity-id";
import { RowActions } from "./row-actions";
import { PageHeader } from "./page-header";
import { PromotionAttributeConditions } from "./attributes";
import { useGrid } from "./grids";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import "./promotions.css";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  promotionApi,
  catalogApi,
  type Promotion,
  type PromotionInput,
} from "@commerce/api-client";
import { Field, Notice, useAction } from "@commerce/ui";
const empty: PromotionInput = {
  name: "",
  scope: "catalog",
  kind: "percentage",
  value: "10",
  coupon_code: null,
  min_subtotal: "0",
  skus: [],
  category_ids: [],
  customer_group: "all",
  priority: 0,
  active: false,
  starts_at: null,
  ends_at: null,
};
function promotionInput(promotion: Promotion): PromotionInput {
  const { id, entity_id, updated_at, ...input } = promotion;
  void id; void entity_id; void updated_at;
  return input;
}
function localTime(value: string | null) {
  if (!value) return "";
  const d = new Date(value);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function state(r: Promotion) {
  const now = Date.now();
  return !r.active
    ? "Disabled"
    : r.ends_at && Date.parse(r.ends_at) <= now
      ? "Expired"
      : r.starts_at && Date.parse(r.starts_at) > now
        ? "Scheduled"
        : "Active";
}
export function Promotions({ canWrite }: { canWrite: boolean }) {
  const q = useGrid("promotions", ["promotions"]),
    categories = useQuery({
      queryKey: ["categories"],
      queryFn: () => catalogApi.categories(),
    }),
    a = useAction(),
    cache = useQueryClient();
  const navigate = useNavigate(), location = useLocation();
  const [deleting, setDeleting] = useState<Promotion>();
  function edit(r?: Promotion) { navigate(`/marketing/promotions/${r?.id ?? "new"}`); }
  async function refresh() {
    await cache.invalidateQueries({ queryKey: ["promotions"] });
  }
  return (
    <main className="catalog-admin">
      <PageHeader title={<>Promotions & coupons</>} description={<>
            Choose one catalog discount per item, then one cart discount. Higher
            priority wins; ties use rule ID. An entered coupon replaces automatic
            cart offers. Discounts apply before tax.
          </>} actions={<>{canWrite && <button onClick={() => edit()}>Add promotion</button>}</>} />
      <Notice error>
        {q.error?.message || categories.error?.message || a.error}
      </Notice>
      <Notice>{a.message || location.state?.message}</Notice>
      {q.controls}
      {q.isPending ? (
        <p>Loading promotions…</p>
      ) : (
        <table>
          <thead>
            <tr>
              <EntityIdHeading/><th>Name / coupon</th>
              <th>Discount</th>
              <th>Scope</th>
              <th>Priority</th>
              <th>State</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((r) => (
              <tr key={r.id}>
                <EntityIdCell row={r}/><td>
                  {r.name}
                  <small>{r.coupon_code || "Automatic"}</small>
                </td>
                <td>
                  {r.kind === "percentage"
                    ? `${r.value}%`
                    : `$${Number(r.value).toFixed(2)}`}
                </td>
                <td>{r.scope}</td>
                <td>{r.priority}</td>
                <td><span className={`promotion-state ${state(r).toLowerCase()}`}>{state(r)}</span></td>
                <td>
                  {canWrite && (
                    <RowActions label={r.name} items={[
                      { label: "Edit", onSelect: () => edit(r) },
                      { label: "Delete", destructive: true, onSelect: () => setDeleting(r) },
                    ]} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {q.data?.length === 0 && (
        <p>No promotions yet. Create an offer to get started.</p>
      )}
      {deleting && (
        <section className="form-card">
          <h2>Delete {deleting.name}?</h2>
          <p>
            This stops future use. Existing orders keep their recorded
            discounts.
          </p>
          <button
            disabled={a.busy}
            onClick={() =>
              a.run(async () => {
                await promotionApi.remove(deleting.id);
                setDeleting(undefined);
                await refresh();
                a.setMessage(
                  "Promotion deleted. Existing orders are unchanged.",
                );
              })
            }
          >
            Confirm delete
          </button>{" "}
          <button className="secondary" onClick={() => setDeleting(undefined)}>
            Keep promotion
          </button>
        </section>
      )}
    </main>
  );
}

export function PromotionEditorPage() {
  const { id } = useParams();
  const isNew = id === "new";
  const query = useQuery({ queryKey: ["promotions", "editor"], queryFn: promotionApi.list, enabled: !isNew });
  if (!isNew && query.isPending) return <main><p role="status">Loading promotion…</p></main>;
  const promotion = query.data?.find(rule => rule.id === id);
  if (!isNew && !promotion) return <main><PageHeader title="Promotion unavailable"/><Notice error>{query.error?.message || "This promotion could not be found."}</Notice><Link to="/marketing/promotions">Back to promotions</Link></main>;
  return <PromotionEditor key={id} promotion={promotion}/>;
}
function PromotionEditor({ promotion }: { promotion?: Promotion }) {
  const id = promotion?.id;
  const [form, setForm] = useState<PromotionInput>(() => promotion ? promotionInput(promotion) : { ...empty });
  const [skus, setSkus] = useState(promotion?.skus.join(", ") ?? "");
  const categories = useQuery({ queryKey: ["categories"], queryFn: () => catalogApi.categories() });
  const a = useAction(), cache = useQueryClient(), navigate = useNavigate();
  return <main className="catalog-admin promotion-editor">
    <Link className="promotion-back" to="/marketing/promotions">← All promotions</Link>
    <PageHeader title={id ? "Edit promotion" : "Create promotion"} description="Set the offer, choose who can use it, and schedule when it runs."/>
    <Notice error>{a.error || categories.error?.message}</Notice>
    <div className="promotion-editor-layout"><section className="form-card">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                if (form.starts_at && form.ends_at && Date.parse(form.ends_at) <= Date.parse(form.starts_at)) throw new Error("End time must be after start time.");
                await promotionApi.save(
                  {
                    ...form,
                    skus: skus
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  },
                  id,
                );

                await cache.invalidateQueries({ queryKey: ["promotions"] });
                navigate("/marketing/promotions", { state: { message: "Promotion saved successfully." } });
                a.setMessage(
                  "Promotion saved. Existing orders keep their discounts.",
                );
              });
            }}
          >
            <Field
              label="Promotion name"
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <div className="form-grid">
              <label className="field">
                Scope
                <select
                  value={form.scope}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      scope: e.target.value as PromotionInput["scope"],
                      coupon_code: null,
                    })
                  }
                >
                  <option value="cart">Cart discount</option>
                  <option value="catalog">Catalog item discount</option>
                </select>
              </label>
              <label className="field">
                Discount type
                <select
                  value={form.kind}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      kind: e.target.value as PromotionInput["kind"],
                    })
                  }
                >
                  <option value="percentage">Percentage</option>
                  <option value="fixed">Fixed amount (USD)</option>
                </select>
              </label>
              <Field
                label={
                  form.kind === "percentage"
                    ? "Discount (%)"
                    : form.scope === "catalog"
                      ? "Discount per unit (USD)"
                      : "Discount per cart (USD)"
                }
                type="number"
                required
                min="0.01"
                max={form.kind === "percentage" ? "100" : "1000000"}
                step="0.01"
                value={form.value}
                onChange={(e) => setForm({ ...form, value: e.target.value })}
              />
              <Field
                label="Priority (higher wins)"
                type="number"
                required
                min="0"
                max="10000"
                step="1"
                value={form.priority}
                onChange={(e) =>
                  setForm({ ...form, priority: Number(e.target.value) })
                }
              />
              {form.scope === "cart" && (
                <Field
                  label="Coupon code (blank = automatic)"
                  maxLength={40}
                  value={form.coupon_code ?? ""}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      coupon_code: e.target.value.toUpperCase() || null,
                    })
                  }
                />
              )}
              <Field
                label="Minimum item subtotal (USD)"
                type="number"
                required
                min="0"
                max="1000000000"
                step="0.01"
                value={form.min_subtotal}
                onChange={(e) =>
                  setForm({ ...form, min_subtotal: e.target.value })
                }
              />
              <label className="field">
                Customer group
                <select
                  value={form.customer_group}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      customer_group: e.target
                        .value as PromotionInput["customer_group"],
                    })
                  }
                >
                  <option value="all">Everyone</option>
                  <option value="guest">Guests</option>
                  <option value="registered">Registered customers</option>
                  <option value="verified">Verified customers</option>
                </select>
              </label>
              <Field
                label="Eligible SKUs (comma-separated, blank = all)"
                value={skus}
                onChange={(e) => setSkus(e.target.value)}
              />
              <Field
                label="Starts at (your local time, optional)"
                type="datetime-local"
                value={localTime(form.starts_at)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    starts_at: e.target.value
                      ? new Date(e.target.value).toISOString()
                      : null,
                  })
                }
              />
              <Field
                label="Ends at (your local time, optional)"
                type="datetime-local"
                value={localTime(form.ends_at)}
                onChange={(e) =>
                  setForm({
                    ...form,
                    ends_at: e.target.value
                      ? new Date(e.target.value).toISOString()
                      : null,
                  })
                }
              />
            </div>
            <fieldset>
              <legend>Eligible categories (none selected = all)</legend>
              {categories.data?.map((c) => (
                <label className="checkbox" key={c.id}>
                  <input
                    type="checkbox"
                    checked={form.category_ids.includes(c.id)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        category_ids: e.target.checked
                          ? [...form.category_ids, c.id]
                          : form.category_ids.filter((id) => id !== c.id),
                      })
                    }
                  />
                  {c.name}
                </label>
              ))}
            </fieldset>
            <p className="help">
              SKU and category filters must both match. Categories match
              directly, not their descendants. Minimums use the full item
              subtotal: before discounts for catalog rules, after catalog
              discounts for cart rules. Registered includes verified accounts.
              Guest offers are rechecked after sign-in.
            </p>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
              />
              Enable promotion
            </label>
            <p className="help">
              Schedules use an inclusive start and exclusive end. Fixed
              discounts are capped at eligible item value. No delivery discounts
              or coupon usage limits in this release.
            </p>
            <div className="promotion-editor-actions"><button disabled={a.busy}>{a.busy ? "Saving…" : "Save promotion"}</button>{" "}
            <button
              type="button"
              className="secondary"
              onClick={() => navigate("/marketing/promotions")}
            >
              Cancel
            </button></div>
          </form>
    {id && <PromotionAttributeConditions key={id} id={id}/>}
    </section><aside className="promotion-preview" aria-label="Promotion summary">
      <span className="promotion-eyebrow">Offer summary</span>
      <h2>{form.name || "Your new promotion"}</h2>
      <span className="promotion-value">{form.kind === "percentage" ? `${form.value || "0"}% off` : `${form.value || "0"} USD off`}</span>
      <dl><div><dt>Applies to</dt><dd>{form.scope === "catalog" ? "Eligible products" : "Eligible cart items"}</dd></div><div><dt>Audience</dt><dd>{form.customer_group === "all" ? "Everyone" : form.customer_group}</dd></div><div><dt>Activation</dt><dd>{form.active ? "Enabled — follows schedule" : "Disabled"}</dd></div></dl>
      <p>{form.scope === "catalog" ? "Eligible one-unit catalog offers appear beside the original price in the store. Minimums and customer restrictions still apply." : "Cart offers appear in the basket and checkout after eligibility is confirmed."}</p>
      <p className="help">Higher priority wins within each scope. Saving does not change existing orders.</p>
    </aside></div>
  </main>;
}
