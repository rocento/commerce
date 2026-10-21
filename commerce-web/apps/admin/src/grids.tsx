import { useEffect, useState } from "react";
import { GridToolbar, gridLabel, type GridExtras, type FilterChip } from "./grid-controls";
import { useQuery } from "@tanstack/react-query";
import type { adminApi, adminOrderApi, adminSupportApi, attributeApi, catalogApi, contentApi, fulfillmentApi, inventoryApi, msiApi, operationsApi, promotionApi, Review } from "@commerce/api-client";

type GridRows = {
  users: Awaited<ReturnType<typeof adminApi.users>>[number];
  roles: Awaited<ReturnType<typeof adminApi.roles>>[number];
  audit: Awaited<ReturnType<typeof adminApi.audit>>[number] & {
    actor_name?: string | null;
    actor_email?: string | null;
    entity_name?: string | null;
    entity_type?: string | null;
  };
  catalog: Awaited<ReturnType<typeof operationsApi.products>>['items'][number];
  attributes: Awaited<ReturnType<typeof catalogApi.attributes>>[number];
  'attribute-definitions': Awaited<ReturnType<typeof attributeApi.list>>[number];
  'order-comments': Awaited<ReturnType<typeof attributeApi.comments>>[number];
  orders: Awaited<ReturnType<typeof adminOrderApi.list>>[number];
  support: Awaited<ReturnType<typeof adminSupportApi.list>>[number];
  promotions: Awaited<ReturnType<typeof promotionApi.list>>[number];
  tax: Awaited<ReturnType<typeof fulfillmentApi.rules>>[number];
  inventory: Awaited<ReturnType<typeof inventoryApi.list>>[number];
  reservations: Awaited<ReturnType<typeof inventoryApi.detail>>['reservations'][number];
  adjustments: Awaited<ReturnType<typeof inventoryApi.detail>>['adjustments'][number];
  sources: Awaited<ReturnType<typeof msiApi.sources>>[number];
  stocks: Awaited<ReturnType<typeof msiApi.stocks>>[number];
  'source-items': Awaited<ReturnType<typeof msiApi.items>>[number];
  content: Awaited<ReturnType<typeof contentApi.list>>[number];
  'cms-revisions': Awaited<ReturnType<typeof contentApi.detail>>['revisions'][number];
  'cms-releases': Awaited<ReturnType<typeof contentApi.detail>>['releases'][number];
  reviews: Review;
  customers: { id: string; readonly entity_id?: number; email: string | null; mobile_number: string | null; primary_identifier: string; verified: boolean; created_at: string; first_name: string; last_name: string; customer_group: string };
};

type Filters = { action?: string; actor_id?: string; entity_id?: string; created_from?: string; created_to?: string; system?: boolean; document_id?:string; entity_type?: string; product_id?: string; order_id?: string; q?: string; status?: string; category_id?: string | null; role_id?: string | null; active?: boolean | null; kind?: string };
type Page<T> = { items: T[]; next_cursor: string | null; total_count?: number };
type Job = { id: string; grid: string; status: string; rows_processed: number; format: string; error?: string };
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`/api/v1/admin/${path}`, { credentials: "include", ...init, headers: { "Content-Type": "application/json", "X-Commerce-Request": "1", ...init?.headers } });
  if (!r.ok) { const body = await r.json().catch(() => ({})); throw new Error(body.error || `Request failed (${r.status})`); }
  return r.json();
}
export function fetchGridPage<Name extends keyof GridRows>(name: Name, cursor: string | null, signal?: AbortSignal): Promise<Page<GridRows[Name]>> {
  const params = new URLSearchParams({ limit: '50', sort: 'id', descending: 'false' });
  if (cursor) params.set('cursor', cursor);
  return request(`grids/${name}?${params}`, { signal });
}

// Grid names determine row types; data always comes from the server grid.
export function useGrid<Name extends keyof GridRows>(name: Name, key: readonly unknown[], filters: Filters = {}, enabled = true, options: { initialStatus?: string; initialSort?: string; initialDescending?: boolean } = {}) {
  const [search,setSearch] = useState("");
  const [active,setActive] = useState(""), [status,setStatus] = useState(options.initialStatus ?? "");
  const [navigation, setNavigation] = useState<{ scope: string; cursors: (string | null)[]; base: number }>({ scope: "", cursors: [null], base: 0 });
  const [limit, setLimit] = useState(50), [descending, setDescending] = useState(options.initialDescending ?? false), [sort, setSort] = useState(options.initialSort ?? "id");
  const [debouncedSearch, setDebouncedSearch] = useState(search);
  useEffect(() => { const timer = setTimeout(() => setDebouncedSearch(search), 250); return () => clearTimeout(timer); }, [search]);
  const sorts = useQuery({enabled, queryKey:["grid-sorts",name],queryFn:()=>request<string[]>(`grids/${name}/sorts`)});
  const activeSupported=["catalog","inventory","users","promotions","tax"].includes(name) && !("active" in filters);
  const statusOptions:Record<string,string[]>={orders:["placed","confirmed","fulfilling","shipped","delivered","cash_collected","cancelled","delivery_failed"],reviews:["pending","approved","rejected"],support:["open","in_progress","resolved","closed"]};
  const statusSupported=!!statusOptions[name] && !("status" in filters);
  const clean = Object.fromEntries(Object.entries({...filters,q:filters.q ?? debouncedSearch,...(activeSupported && active ? {active:active==="true"}:{}),...(statusSupported && status ? {status}: {})}).filter(([,v]) => v !== null && v !== undefined && v !== ""));
  const scope = JSON.stringify([name, clean, limit, descending, sort]);
  const cursors = navigation.scope === scope ? navigation.cursors : [null];
  const base = navigation.scope === scope ? navigation.base : 0;
  const cursor = cursors[cursors.length - 1];
  const params = { ...clean, limit, descending, sort, ...(cursor ? { cursor } : {}) };
  const q = useQuery({ enabled, queryKey: [...key, "grid", scope, cursor], queryFn: ({signal}) => request<Page<GridRows[Name]>>(`grids/${name}?${new URLSearchParams(Object.entries(params).map(([k,v]) => [k,String(v)]))}`, {signal}), gcTime: 0 });
  const resetFilters = () => { setSearch(""); setActive(""); setStatus(""); };
  const renderControls = (extras: GridExtras = {}) => {
    const chips: FilterChip[] = [
      ...(filters.q === undefined && search ? [{ label: `Search: ${search}`, remove: () => setSearch("") }] : []),
      ...(activeSupported && active ? [{ label: `Active: ${active === "true" ? "Active" : "Inactive"}`, remove: () => setActive("") }] : []),
      ...(statusSupported && status ? [{ label: `Status: ${gridLabel(status)}`, remove: () => setStatus("") }] : []),
      ...(extras.chips ?? []),
    ];
    const hasFilters = activeSupported || statusSupported || !!extras.filters;
    return <GridToolbar name={name} search={filters.q === undefined ? search : undefined} onSearch={setSearch}
      filters={hasFilters ? <>
        {activeSupported && <label className="grid-field">Active<select aria-label="Active" value={active} onChange={e => setActive(e.target.value)}><option value="">All</option><option value="true">Active</option><option value="false">Inactive</option></select></label>}
        {statusSupported && <label className="grid-field">Status<select aria-label="Status" value={status} onChange={e => setStatus(e.target.value)}><option value="">All statuses</option>{statusOptions[name].map(v => <option key={v} value={v}>{gridLabel(v)}</option>)}</select></label>}
        {extras.filters}
      </> : undefined}
      chips={chips} clearFilters={() => { resetFilters(); extras.clearFilters?.(); }}
      sort={sort} sorts={sorts.data ?? [sort]} onSort={setSort} descending={descending} onDirection={setDescending}
      limit={limit} onLimit={setLimit} page={base+cursors.length} count={q.data?.items.length ?? 0} total={q.data?.total_count}
      busy={q.isFetching || (filters.q === undefined && search !== debouncedSearch)} error={q.error?.message}
      sortError={sorts.error?.message} retrySorts={() => void sorts.refetch()} refresh={() => void q.refetch()}
      first={() => setNavigation({scope,cursors:[null],base:0})}
      previous={() => setNavigation({scope,cursors:cursors.slice(0,-1),base})}
      next={() => { if (q.data?.next_cursor) setNavigation({scope,cursors:[...cursors,q.data.next_cursor].slice(-100),base:base+(cursors.length===100?1:0)}); }}
      canPrevious={cursors.length > 1} canNext={!!q.data?.next_cursor}/>;
  };
  return { ...q, filters: { ...clean, sort, descending }, data: q.data?.items, controls: renderControls(), renderControls, page: q.data };

}
export function ExportTools({grid, filters = {}}: {grid: string; filters?: Filters & {descending?: boolean;sort?:string}}) {
  const [open,setOpen] = useState(true), [selected,setSelected] = useState<string[] | null>(null), [format,setFormat] = useState("csv"), [busy,setBusy] = useState(false), [error,setError] = useState("");
  const cols = useQuery({queryKey:["export-columns",grid],queryFn:() => request<{columns:string[]}>(`exports/columns/${grid}`),enabled:open,retry:false});
  const jobs = useQuery({queryKey:["exports",grid],queryFn:() => request<Job[]>("exports"),enabled:open,refetchInterval:open ? 2000 : false});
  const columns = selected ?? cols.data?.columns ?? [];
  return <details open={open} onToggle={e => setOpen(e.currentTarget.open)}><summary>Export filtered data / downloads</summary>
    <p>Runs in the background. Downloads expire after 24 hours. Excel exports split into worksheets automatically.</p>
    {cols.error ? <p role="alert">{cols.error.message}</p> : <>
      <label>File format <select value={format} onChange={e => setFormat(e.target.value)}><option value="csv">CSV</option><option value="xlsx">Excel (.xlsx)</option></select></label>
      <fieldset><legend>Columns (file order shown below)</legend>{cols.data?.columns.map(c => <label key={c} style={{display:"inline-block",marginRight:16}}><input type="checkbox" checked={columns.includes(c)} onChange={e => setSelected(e.target.checked ? [...columns,c] : columns.filter(v => v !== c))}/>{c}</label>)}</fieldset>
      <p>{columns.join(", ")}</p>
      <button type="button" disabled={busy || !columns.length} onClick={async () => {setBusy(true);setError("");try {await request("exports",{method:"POST",body:JSON.stringify({grid,request:filters,columns,format})});await jobs.refetch();}catch(e){setError(e instanceof Error ? e.message : "Export failed");}finally{setBusy(false);}}}>Start background export</button>
    </>}
    {error && <p role="alert">{error}</p>}
    {jobs.error && <p role="alert">{jobs.error.message}</p>}
    <ul aria-live="polite">{jobs.data?.filter(j => j.grid === grid).map(j => <li key={j.id}>{j.format.toUpperCase()} · {j.status} · {j.rows_processed.toLocaleString()} rows processed {j.error}
      {j.status === "completed" && <> · <a href={`/api/v1/admin/exports/${j.id}/download`}>Download</a></>}
      {["queued","running"].includes(j.status) && <> · <button type="button" onClick={async () => {try{await request(`exports/${j.id}`,{method:"DELETE"});await jobs.refetch();}catch(e){setError(String(e));}}}>Cancel</button></>}
    </li>)}</ul>
  </details>;
}
