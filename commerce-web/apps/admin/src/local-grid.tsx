import { useState } from "react";
import { GridToolbar, type GridExtras } from "./grid-controls";
import { matchesEntityId, numericEntityId } from "./entity-id";

type LocalGridOptions<T> = {
  name: string;
  rows: T[] | undefined;
  searchText: (row: T) => string;
  sorts: Record<string, (row: T) => string | number | null>;
  initialSort: string;
  scope?: string;
  busy: boolean;
  error?: string;
  refresh: () => void;
};
// Only for endpoints that return the complete collection, never a server page.
export function useLocalGrid<T>(options: LocalGridOptions<T>) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState(options.initialSort);
  const [descending, setDescending] = useState(false);
  const [limit, setLimit] = useState(50);
  const [navigation, setNavigation] = useState({ scope: "", page: 1 });
  const term = search.trim().toLocaleLowerCase();
  const hasEntityIds = options.rows?.some(row => numericEntityId(row) !== null);
  const sorts: LocalGridOptions<T>["sorts"] = { ...options.sorts, ...(hasEntityIds ? { entity_id: (row: T) => numericEntityId(row) } : {}) };
  const activeSort = sort in sorts ? sort : options.initialSort;
  const sorted = (options.rows ?? []).filter(row => !term || matchesEntityId(row, term) || options.searchText(row).toLocaleLowerCase().includes(term)).sort((a, b) => {
    const left = sorts[activeSort](a), right = sorts[activeSort](b);
    if (left === null) return right === null ? 0 : 1;
    if (right === null) return -1;
    const order = typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right), undefined, { numeric: true });
    return descending ? -order : order;
  });
  const scope = JSON.stringify([search,sort,descending,limit,options.scope]);
  const page = Math.min(navigation.scope === scope ? navigation.page : 1, Math.max(1, Math.ceil(sorted.length / limit)));
  const data = sorted.slice((page - 1) * limit, page * limit);
  const renderControls = (extras: GridExtras = {}) => <GridToolbar name={options.name} search={search} onSearch={setSearch}
    filters={extras.filters} chips={[...(search ? [{ label: `Search: ${search}`, remove: () => setSearch("") }] : []), ...(extras.chips ?? [])]}
    clearFilters={() => { setSearch(""); extras.clearFilters?.(); }} sort={activeSort} sorts={Object.keys(sorts)} onSort={setSort}
    descending={descending} onDirection={setDescending} limit={limit} onLimit={setLimit} page={page} count={data.length} total={sorted.length}
    busy={options.busy} error={options.error} refresh={options.refresh} canPrevious={page > 1} canNext={page * limit < sorted.length}
    first={() => setNavigation({scope,page:1})} previous={() => setNavigation({scope,page:page-1})} next={() => setNavigation({scope,page:page+1})}/>;
  return { data, controls: renderControls(), renderControls };
}
