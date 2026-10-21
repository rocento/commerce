import { EntityIdHeading, EntityIdCell } from "./entity-id";
import { ReasonField, reasonOptions } from "./reason-field";
import { RowActions } from "./row-actions";
import { useGrid } from "./grids";
import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  catalogApi,
  mediaUrl,
  operationsApi,
  type CatalogFilter,
  type BulkInput,
} from "@commerce/api-client";
import { Field, Notice, useAction } from "@commerce/ui";
import { useCatalogRefresh } from "./catalog";
export const emptyFilter: CatalogFilter = {
  q: "",
  category_id: null,
  active: null,
  offset: 0,
};
function ProductThumbnail({ mediaId, name }: { mediaId?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return <span className="catalog-product-thumbnail">
    {mediaId && !failed ? <img src={mediaUrl(mediaId)} alt={`${name} cover`} width={48} height={48} loading="lazy" decoding="async" onError={() => setFailed(true)} /> : <svg role="img" aria-label={mediaId ? `Image unavailable for ${name}` : `No image for ${name}`} viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m3 17 5-5 4 4 3-3 6 6"/></svg>}
  </span>;
}
export function CsvTools({
  kind,
  canImport,
}: {
  kind: "catalog" | "inventory";
  filter?: CatalogFilter;
  canImport: boolean;
  canExport: boolean;
}) {
  const fileRevision = useRef(0);
  const [csv, setCsv] = useState(""),
    [reason, setReason] = useState(""),
    [preview, setPreview] = useState<{ count: number; skus: string[]; csv: string; reason: string }>(),
    a = useAction(),
    cache = useQueryClient();
  const headers =
    kind === "catalog"
      ? "sku,slug,name,description,price,currency,unit,category_id,attributes,media_ids,active"
      : "sku,on_hand,reason";
  return (
    <details className="form-card" open>
      <summary>
        {kind === "catalog" ? "Catalog" : "Inventory"} CSV import
      </summary>
      <p>
        Imports support up to 500 products per file, 2 MB maximum. Catalog import creates or updates by SKU; inventory
        import updates existing SKUs only.
      </p>
      <Notice error>{a.error}</Notice>
      <Notice>{a.message}</Notice>
      {canImport && (
        <>
          <p>
            Required headers: <code>{headers}</code>
          </p>
          <p>
            Use UTF-8 CSV with the exact headers below. Catalog attributes and media IDs use JSON in CSV cells.
            Report exports may contain different columns and must be mapped to this template before importing.
            Formula-like text is protected on export and restored on import.
          </p>
          <a download={`${kind}-import-template.csv`} href={`data:text/csv;charset=utf-8,${encodeURIComponent(headers + "\r\n")}`}>Download CSV template</a>
          <label className="field">
            Choose CSV file
            <input
              type="file"
              disabled={a.busy}
              accept=".csv,text/csv"
              onChange={(e) => {
                const revision = ++fileRevision.current;
                const f = e.target.files?.[0];
                setCsv("");
                setPreview(undefined);
                if (!f) return;
                if (f.size > 2 * 1024 * 1024) {
                  void a.run(async () => {
                    throw new Error("CSV must be at most 2 MB");
                  });
                  return;
                }
                void a.run(async () => {
                  let content: string;
                  try { content = new TextDecoder("utf-8", { fatal: true }).decode(await f.arrayBuffer()); }
                  catch { throw new Error("Could not read this file. Save it as UTF-8 CSV and try again."); }
                  if (fileRevision.current === revision) setCsv(content);
                });
              }}
            />
          </label>
          <label className="field">
            CSV content
            <textarea
              value={csv}
              disabled={a.busy}
              onChange={(e) => {
                fileRevision.current++;
                setCsv(e.target.value);
                setPreview(undefined);
              }}
              spellCheck={false}
            />
          </label>
          <ReasonField
            label="Import reason" options={kind === "catalog" ? reasonOptions.catalogImport : reasonOptions.inventoryImport}
            disabled={a.busy}
            required
            maxLength={300}
            value={reason}
            onValueChange={(value) => {
              setReason(value);
              setPreview(undefined);
            }}
          />
          <button
            className="secondary"
            disabled={a.busy || !csv || !reason.trim()}
            onClick={() =>
              a.run(async () => {
                setPreview(undefined);
                const result = await operationsApi.import(kind, {
                  csv,
                  reason,
                  preview: true,
                });
                setPreview({ ...result, csv, reason });
              })
            }
          >
            Validate and preview
          </button>
          {preview && preview.csv === csv && preview.reason === reason && (
            <section className="selection-toolbar">
              <h3>{preview.count} valid rows ready to import</h3>
              <p>
                SKUs: {preview.skus.slice(0, 20).join(", ")}
                {preview.skus.length > 20 ? " …" : ""}
              </p>
              <p>
                Apply all rows together. The file will be validated again
                against current data; any invalid row prevents the entire
                import.
              </p>
              <button
                disabled={a.busy}
                onClick={() =>
                  a.run(async () => {
                    const r = await operationsApi.import(kind, {
                      csv,
                      reason,
                      preview: false,
                    });
                    setPreview(undefined);
                    setCsv("");
                    await cache.invalidateQueries({
                      predicate: (q) =>
                        ["catalog", "inventory"].includes(
                          String(q.queryKey[0]),
                        ),
                    });
                    a.setMessage(
                      `Imported ${r.count} rows. Audit reference: ${r.operation_id}`,
                    );
                  })
                }
              >
                Apply {preview.count} rows
              </button>
            </section>
          )}
        </>
      )}
    </details>
  );
}
export function ProductOperations({
  canWrite,
  canBulk,
}: {
  canWrite: boolean;
  canBulk: boolean;
}) {
  const refresh = useCatalogRefresh();
  const [filter, setFilter] = useState<CatalogFilter>({ ...emptyFilter }),
    [selected, setSelected] = useState<string[]>([]),
    [pending, setPending] = useState<BulkInput>(),
    [name, setName] = useState("");
  const navigate = useNavigate();
  const q = useGrid("catalog", ["catalog", "operations"], {q:filter.q, category_id:filter.category_id, active:filter.active}),
    cats = useQuery({
      queryKey: ["catalog", "categories"],
      queryFn: () => catalogApi.categories(),
    }),
    saved = useQuery({
      queryKey: ["catalog", "saved-filters"],
      queryFn: operationsApi.filters,
    }),
    a = useAction(),
    cache = useQueryClient();
  function applyFilter(f: CatalogFilter) {
    setSelected([]);
    setFilter({ ...f, offset: 0 });
  }
  const allOnPage =
    !!q.data?.length &&
    q.data?.every((p) => selected.includes(p.id));
  return (
    <>
      <Notice error>
        {q.error?.message ||
          cats.error?.message ||
          saved.error?.message ||
          a.error}
      </Notice>
      <Notice>{a.message}</Notice>
      {q.renderControls({
        filters: (<form
        className="grid-custom-filters"
        key={JSON.stringify({
          q: filter.q,
          category_id: filter.category_id,
          active: filter.active,
        })}
        onSubmit={(e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget);
          applyFilter({
            q: String(d.get("q")),
            category_id: String(d.get("category")) || null,
            active: d.get("active") === "" ? null : d.get("active") === "true",
            offset: 0,
          });
        }}
      >
        <Field
          label="Search name or SKU"
          name="q"
          maxLength={200}
          defaultValue={filter.q}
        />
        <label className="field">
          Category
          <select name="category" defaultValue={filter.category_id ?? ""}>
            <option value="">All categories</option>
            {cats.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Status
          <select
            name="active"
            defaultValue={filter.active === null ? "" : String(filter.active)}
          >
            <option value="">All statuses</option>
            <option value="true">Published</option>
            <option value="false">Draft</option>
          </select>
        </label>
        <button>Apply filters</button>
      </form>),
        chips: [
          ...(filter.q ? [{ label: `Search: ${filter.q}`, remove: () => applyFilter({ ...filter, q: "" }) }] : []),
          ...(filter.category_id ? [{ label: `Category: ${cats.data?.find(c => c.id === filter.category_id)?.name ?? "Selected category"}`, remove: () => applyFilter({ ...filter, category_id: null }) }] : []),
          ...(filter.active !== null && filter.active !== undefined ? [{ label: `Status: ${filter.active ? "Published" : "Draft"}`, remove: () => applyFilter({ ...filter, active: null }) }] : []),
        ],
        clearFilters: () => applyFilter({ ...emptyFilter }),
      })}
      <div className="catalog-toolbar saved-filter-bar">
        <label className="field">
          Saved filters
          <select
            value=""
            onChange={(e) => {
              const f = saved.data?.find((f) => f.id === e.target.value);
              if (f) applyFilter(f.filters);
            }}
          >
            <option value="">Choose a saved filter</option>
            {saved.data?.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="Save current filter as"
          maxLength={100}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="secondary"
          disabled={a.busy || !name.trim()}
          onClick={() =>
            a.run(async () => {
              await operationsApi.saveFilter(name, filter);
              await cache.invalidateQueries({
                queryKey: ["catalog", "saved-filters"],
              });
              setName("");
              a.setMessage("Filter saved to your admin account.");
            })
          }
        >
          Save filter
        </button>
      </div>
      {saved.data && saved.data.length > 0 && (
        <details>
          <summary>Manage saved filters</summary>
          {saved.data.map((f) => (
            <p key={f.id}>
              {f.name}{" "}
              <button
                className="text-button"
                disabled={a.busy}
                onClick={() =>
                  a.run(async () => {
                    await operationsApi.deleteFilter(f.id);
                    await cache.invalidateQueries({
                      queryKey: ["catalog", "saved-filters"],
                    });
                  })
                }
              >
                Remove saved filter
              </button>
            </p>
          ))}
        </details>
      )}
      <div className="catalog-toolbar product-list-heading">
        <p>
          {q.data?.length ?? 0} products on this page · {selected.length} selected
        </p>
      </div>
      {canBulk && (
        <section className="selection-toolbar">
          <button
            className="secondary"
            disabled={a.busy || !q.data?.length}
            onClick={() =>
              a.run(async () => setSelected(await operationsApi.ids(filter)))
            }
          >
            Select all matching (up to 500)
          </button>{" "}
          <button className="text-button" onClick={() => setSelected([])}>
            Clear selection
          </button>
          {selected.length > 0 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const d = new FormData(e.currentTarget);
                setPending({
                  ids: [...selected],
                  category_id: String(d.get("category")) || null,
                  active:
                    d.get("active") === "" ? null : d.get("active") === "true",
                  price_adjustment_pct: String(d.get("price")) || null,
                  reason: String(d.get("reason")),
                });
              }}
            >
              <h3>Bulk edit {selected.length} products</h3>
              <div className="form-grid">
                <label className="field">
                  Move to category
                  <select name="category">
                    <option value="">Keep category</option>
                    {cats.data?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  New status
                  <select name="active">
                    <option value="">Keep status</option>
                    <option value="true">Published</option>
                    <option value="false">Draft</option>
                  </select>
                </label>
                <Field
                  label="Price adjustment (%)"
                  name="price"
                  type="number"
                  min="-100"
                  max="1000"
                  step="0.01"
                  placeholder="For example, 5 or -10"
                />
                <ReasonField
                  label="Bulk change reason" options={reasonOptions.bulk}
                  name="reason"
                  required
                  maxLength={300}
                />
              </div>
              <button disabled={a.busy}>Review bulk change</button>
            </form>
          )}
        </section>
      )}
      {pending && (
        <section className="form-card">
          <h2>Confirm changes to {pending.ids.length} products</h2>
          <p>
            Category:{" "}
            {pending.category_id
              ? cats.data?.find((c) => c.id === pending.category_id)?.name
              : "unchanged"}{" "}
            · Status:{" "}
            {pending.active === null
              ? "unchanged"
              : pending.active
                ? "Published"
                : "Draft"}{" "}
            · Price: {pending.price_adjustment_pct ?? "0"}% adjustment
          </p>
          <p>Reason: {pending.reason}</p>
          <p>
            Uses current prices, rounded to cents. All selected products change
            together; any invalid product cancels the batch.
          </p>
          <button
            disabled={a.busy}
            onClick={() =>
              a.run(async () => {
                const r = await operationsApi.bulk(pending);
                setPending(undefined);
                setSelected([]);
                await cache.invalidateQueries({ queryKey: ["catalog"] });
                a.setMessage(
                  `Updated ${r.count} products. Audit reference: ${r.operation_id}`,
                );
              })
            }
          >
            Apply bulk change
          </button>{" "}
          <button className="secondary" onClick={() => setPending(undefined)}>
            Cancel bulk change
          </button>
        </section>
      )}
      {q.isPending ? (
        <p>Loading products…</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <EntityIdHeading/>{canBulk && (
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select this page"
                      checked={allOnPage}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [
                                ...new Set([
                                  ...selected,
                                  ...(q.data?.map((p) => p.id) ?? []),
                                ]),
                              ].slice(0, 500)
                            : selected.filter(
                                (id) => !q.data?.some((p) => p.id === id),
                              ),
                        )
                      }
                    />
                  </th>
                )}
                <th>Product</th>
                <th>SKU</th>
                <th>Price</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {q.data?.map((p) => (
                <tr key={p.id}>
                  <EntityIdCell row={p}/>{canBulk && (
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${p.sku}`}
                        checked={selected.includes(p.id)}
                        disabled={
                          !selected.includes(p.id) && selected.length >= 500
                        }
                        onChange={(e) =>
                          setSelected(
                            e.target.checked
                              ? [...selected, p.id]
                              : selected.filter((id) => id !== p.id),
                          )
                        }
                      />
                    </td>
                  )}
                  <td><div className="catalog-product-identity"><ProductThumbnail key={p.media_ids?.[0] ?? 'no-image'} mediaId={p.media_ids?.[0]} name={p.name}/><span>{p.name}</span></div></td>
                  <td>{p.sku}</td>
                  <td>
                    ${Number(p.price).toFixed(2)} / {p.unit}
                  </td>
                  <td>{p.active ? "Published" : "Draft"}</td>
                  <td>
                    {canWrite && (
                      <RowActions label={p.name} items={[
                      { label: "Edit", onSelect: () => navigate(`/catalog/products/${p.id}`) },
                      { label: "Delete", destructive: true, confirm: "This permanently removes the record. This action cannot be undone.", onSelect: async () => { await catalogApi.deleteProduct(p.id); await refresh(); } },
                    ]} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!q.isPending && !q.data?.length && (
        <p>No products match these filters.</p>
      )}
    </>
  );
}
