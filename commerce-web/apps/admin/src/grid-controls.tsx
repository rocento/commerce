import type { ReactNode } from "react";
import "./grids.css";

export const gridLabel = (value: string) => value === "entity_id" ? "Entity ID" : value === "id" ? "ID" : value === "sku" ? "SKU" : value.replace(/[_-]/g, " ").replace(/^./, c => c.toUpperCase());
export type FilterChip = { label: string; remove: () => void };
export type GridExtras = { filters?: ReactNode; chips?: FilterChip[]; clearFilters?: () => void };
export type GridToolbarProps = {
  name: string;
  search?: string;
  onSearch: (value: string) => void;
  filters?: ReactNode;
  chips: FilterChip[];
  clearFilters: () => void;
  sort: string;
  sorts: string[];
  onSort: (value: string) => void;
  descending: boolean;
  onDirection: (value: boolean) => void;
  limit: number;
  pageSizes?: number[];
  onLimit: (value: number) => void;
  page: number;
  count: number;
  total?: number;
  busy: boolean;
  error?: string;
  sortError?: string;
  retrySorts?: () => void;
  refresh: () => void;
  first: () => void;
  previous: () => void;
  next: () => void;
  canPrevious: boolean;
  canNext: boolean;
};

export function GridToolbar(p: GridToolbarProps) {
  return <section className="grid-controls" aria-label={`${p.name} pagination`}>
    <div className="grid-toolbar-main">
      {p.search !== undefined && <label className="grid-field grid-search">Search
        <span className="grid-search-input"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></svg><input type="search" value={p.search} placeholder={`Search ${gridLabel(p.name).toLowerCase()}…`} maxLength={200} onChange={e => p.onSearch(e.target.value)}/></span>
      </label>}
      <div className="grid-sort-controls">
        {p.sorts.length > 0 && <><label className="grid-field">Sort column<select aria-label="Sort column" value={p.sort} onChange={e => p.onSort(e.target.value)}>{p.sorts.map(s => <option value={s} key={s}>{gridLabel(s)}</option>)}</select></label>
        <label className="grid-field">Direction<select aria-label="Direction" value={String(p.descending)} onChange={e => p.onDirection(e.target.value === "true")}><option value="false">↑ Ascending</option><option value="true">↓ Descending</option></select></label></>}
        <button type="button" className="secondary grid-refresh" disabled={p.busy} onClick={p.refresh} aria-label={`Refresh ${gridLabel(p.name).toLowerCase()}`}>↻ <span>Refresh</span></button>
      </div>
    </div>
    {p.filters && <div className="grid-filter-row" role="group" aria-label="Filters">{p.filters}</div>}
    {p.chips.length > 0 && <div className="grid-filter-summary" aria-label="Applied filters"><span>Filtered by</span>{p.chips.map((chip, i) => <button type="button" className="grid-filter-chip" key={`${i}-${chip.label}`} onClick={chip.remove} aria-label={`Remove ${chip.label}`}>{chip.label}<span aria-hidden="true">×</span></button>)}<button type="button" className="grid-clear" onClick={p.clearFilters}>Clear filters</button></div>}
    <div className="grid-pagination">
      <span className="grid-result-count" role="status" aria-live="polite">{p.busy ? "Loading…" : p.error ? "Unable to load results" : <><strong className="grid-total">{p.total === undefined ? "Total unavailable" : `${p.total.toLocaleString()} ${p.total === 1 ? "item" : "items"}`}</strong><span className="grid-visible-range">{p.count ? `Showing ${((p.page - 1) * p.limit + 1).toLocaleString()}–${((p.page - 1) * p.limit + p.count).toLocaleString()}` : "No items to display"}{p.chips.length > 0 ? " · Filtered results" : ""}</span></>}</span>
      <div className="grid-page-actions">
        <label className="grid-field grid-page-size">Rows<select aria-label="Rows" value={p.limit} onChange={e => p.onLimit(Number(e.target.value))}>{(p.pageSizes ?? [25,50,100,200]).map(n => <option key={n} value={n}>{n}</option>)}</select></label>
        <nav className="grid-page-nav" aria-label={`${p.name} pages`}>
          <button type="button" className="secondary" disabled={p.busy || p.page === 1} onClick={p.first}>First</button>
          <button type="button" className="secondary" disabled={p.busy || !p.canPrevious} onClick={p.previous}>Previous</button>
          <span className="grid-page-number" aria-live="polite">Page {p.page}</span>
          <button type="button" className="secondary" disabled={p.busy || !p.canNext} onClick={p.next}>Next</button>
        </nav>
      </div>
    </div>
    {p.error && <div className="grid-error" role="alert"><span>{p.error}</span><button type="button" className="secondary" disabled={p.busy} onClick={p.refresh}>Retry</button></div>}
    {p.sortError && <div className="grid-error" role="alert"><span>Sort options could not be loaded. {p.sortError}</span><button type="button" className="secondary" onClick={p.retrySorts}>Retry sort options</button></div>}
  </section>;
}
