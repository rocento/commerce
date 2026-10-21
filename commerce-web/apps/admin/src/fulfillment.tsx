import { DeliveryFeeRules } from './delivery-fee-rules';
import { EntityIdHeading, EntityIdCell } from "./entity-id";
import { ReasonField, reasonOptions } from "./reason-field";
import { RowActions } from "./row-actions";
import { PageHeader } from "./page-header";
import { useGrid } from "./grids";
import { useUnsavedChanges } from "./unsaved-changes";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fulfillmentApi,
  type TaxRuleInput,
  type TaxRule,
} from "@commerce/api-client";
import { Field, Notice, useAction } from "@commerce/ui";
export function DeliveryFee({ canWrite }: { canWrite: boolean }) {
  const q = useQuery({
      queryKey: ["delivery-fee"],
      queryFn: fulfillmentApi.fee,
    }),
    a = useAction(),
    cache = useQueryClient();
  const [amount, setAmount] = useState(""),
    [reason, setReason] = useState("");
  useUnsavedChanges(canWrite && (Boolean(amount) || Boolean(reason)));
  return (
    <main className="catalog-admin">
      <PageHeader title={<>Delivery fee</>} description={<>
        Set the public default and location or warehouse overrides. Changes apply to new checkout reviews;
        previous orders keep their original fee.
      </>} />
      <Notice error>{q.error?.message || a.error}</Notice>
      <Notice>{a.message}</Notice>
      {q.data && (
        <section className="form-card">
          <h2>
            Public default: {Number(q.data.amount).toFixed(2)} {q.data.currency}
          </h2>
          {canWrite && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void a.run(async () => {
                  await fulfillmentApi.setFee(amount, reason);
                  await cache.invalidateQueries({ queryKey: ["delivery-fee"] });
                  setAmount("");
                  setReason("");
                  a.setMessage("Delivery fee saved.");
                });
              }}
            >
              <Field
                label={`Public default fee (${q.data.currency})`}
                type="number"
                min="0"
                max="1000000"
                step="0.01"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              <ReasonField
                label="Change reason" options={reasonOptions.fee}
                required
                maxLength={300}
                value={reason}
                onValueChange={(value) => setReason(value)}
              />
              <button disabled={a.busy}>Save delivery fee</button>
            </form>
          )}
        </section>
      )}
      <DeliveryFeeRules canWrite={canWrite} currency={q.data?.currency??''} />
    </main>
  );
}
const empty: TaxRuleInput = {
  name: "",
  min_lat: -90,
  max_lat: 90,
  min_lon: -180,
  max_lon: 180,
  rate_bps: 0,
  tax_delivery: false,
  priority: 0,
  active: false,
};
export function TaxRules({ canWrite }: { canWrite: boolean }) {
  const q = useGrid("tax", ["tax"]),
    a = useAction(),
    cache = useQueryClient();
  const [form, setForm] = useState<TaxRuleInput>(empty),
    [baseline, setBaseline] = useState<TaxRuleInput>(empty),
    [id, setId] = useState<string>(),
    [show, setShow] = useState(false);
  const dirty = canWrite && show && JSON.stringify(form) !== JSON.stringify(baseline);
  useUnsavedChanges(dirty);
  function discardDraft() {
    return !dirty || window.confirm("Discard unsaved changes to this tax rule?");
  }
  function edit(r: TaxRule) {
    if (!discardDraft()) return;
    const { id, entity_id: _entityId, updated_at: _, ...input } = r;
    void _entityId;
    void _;
    setId(id);
    setForm(input);
    setBaseline(input);
    setShow(true);
  }
  return (
    <main className="catalog-admin">
      <PageHeader title={<>Tax rules</>} description={<>
            Configure rates for rectangular geographic zones. The active matching
            rule with the highest priority wins; rates do not stack. No matching
            rule means no tax.
          </>} actions={<>{canWrite && (
          <button
            onClick={() => {
              if (!discardDraft()) return;
              setId(undefined);
              setForm({ ...empty });
              setBaseline({ ...empty });
              setShow(true);
            }}
          >
            Add tax rule
          </button>
        )}</>} />
      {q.controls}
      <Notice error>{q.error?.message || a.error}</Notice>
      <Notice>{a.message}</Notice>
      {q.isPending ? (
        <p>Loading rules…</p>
      ) : (
        <div className="table-wrap" role="region" aria-label="Tax rules table" tabIndex={0}><table>
          <thead>
            <tr>
              <EntityIdHeading/><th>Rule</th>
              <th>Rate</th>
              <th>Priority</th>
              <th>Delivery taxed</th>
              <th>State</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {q.data?.map((r) => (
              <tr key={r.id}>
                <EntityIdCell row={r}/><td>{r.name}</td>
                <td>{(r.rate_bps / 100).toFixed(2)}%</td>
                <td>{r.priority}</td>
                <td>{r.tax_delivery ? "Yes" : "No"}</td>
                <td>{r.active ? "Active" : "Inactive"}</td>
                <td>
                  {canWrite && (
                    <RowActions label={r.name} items={[{ label: "Edit", onSelect: () => edit(r) }]} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {q.data?.length === 0 && (
        <p>No tax rules configured. Checkout tax is zero.</p>
      )}
      {show && canWrite && (
        <section className="form-card">
          <h2>{id ? "Edit tax rule" : "New tax rule"}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void a.run(async () => {
                await fulfillmentApi.saveRule(form, id);
                await cache.invalidateQueries({ queryKey: ["tax"] });
                setShow(false);
                a.setMessage("Tax rule saved. Past orders are unchanged.");
              });
            }}
          >
            <Field
              label="Rule name"
              required
              maxLength={100}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <div className="form-grid">
              <Field
                label="Rate (basis points; 100 = 1%)"
                type="number"
                step="1"
                min="0"
                max="10000"
                required
                value={form.rate_bps}
                onChange={(e) =>
                  setForm({ ...form, rate_bps: Number(e.target.value) })
                }
              />
              <Field
                label="Priority (unique; higher wins)"
                type="number"
                step="1"
                min="0"
                max="10000"
                required
                value={form.priority}
                onChange={(e) =>
                  setForm({ ...form, priority: Number(e.target.value) })
                }
              />
              {(["min_lat", "max_lat", "min_lon", "max_lon"] as const).map(
                (k) => (
                  <Field
                    key={k}
                    label={k
                      .replace("min", "Minimum")
                      .replace("max", "Maximum")
                      .replace("_lat", " latitude")
                      .replace("_lon", " longitude")}
                    type="number"
                    step="any"
                    required
                    min={k.endsWith("lat") ? -90 : -180}
                    max={k.endsWith("lat") ? 90 : 180}
                    value={form[k]}
                    onChange={(e) =>
                      setForm({ ...form, [k]: Number(e.target.value) })
                    }
                  />
                ),
              )}
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.tax_delivery}
                onChange={(e) =>
                  setForm({ ...form, tax_delivery: e.target.checked })
                }
              />
              Include delivery fee in taxable amount
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
              />
              Enable rule
            </label>
            <p className="help">
              Tax is calculated on the order subtotal, plus delivery when
              selected, and rounded once to cents with halves rounded up. Bounds
              include their edges. Disable a rule to stop applying it.
            </p>
            <button disabled={a.busy}>Save tax rule</button>{" "}
            <button
              className="secondary"
              type="button"
              onClick={() => { if (discardDraft()) setShow(false); }}
            >
              Cancel
            </button>
          </form>
        </section>
      )}
    </main>
  );
}
