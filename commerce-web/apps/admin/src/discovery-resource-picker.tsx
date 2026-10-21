import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { catalogApi } from '@commerce/api-client';
import { Field, Notice } from '@commerce/ui';
export type ResourceKind = 'product' | 'category' | 'content';
type Resource = { id: string; name?: string; key?: string; sku?: string; slug?: string };
type Page = { items: Resource[]; next_cursor: string | null };
export function DiscoveryResourcePicker({ kind, onSelect }: { kind: ResourceKind; onSelect: (id: string, label: string) => void }) {
  const [search, setSearch] = useState(''), [debounced, setDebounced] = useState('');
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  useEffect(() => { const timer = setTimeout(() => { setDebounced(search); setCursors([null]); }, 250); return () => clearTimeout(timer); }, [search]);
  const cursor = cursors[cursors.length - 1];
  const query = useQuery({ queryKey: ['discovery-resource-picker', kind, debounced, cursor], retry: false, queryFn: async ({ signal }): Promise<Page> => {
    if (kind === 'category') {
      const categories = await catalogApi.adminCategories();
      return { items: categories.filter(row => `${row.name} ${row.slug}`.toLowerCase().includes(debounced.toLowerCase())), next_cursor: null };
    }
    const params = new URLSearchParams({ q: debounced, limit: '20', sort: kind === 'product' ? 'name' : 'key', ...(cursor ? { cursor } : {}), ...(kind === 'content' ? { kind: 'page' } : {}) });
    const response = await fetch(`/api/v1/admin/grids/${kind === 'product' ? 'catalog' : 'content'}?${params}`, { credentials: 'include', signal });
    if (!response.ok) throw new Error(response.status === 403 ? 'You need access to this catalog or content section to choose a page.' : 'Unable to load pages. Try searching again.');
    return response.json();
  } });
  const searching = search !== debounced;
  return <div><Field label={kind === 'product' ? 'Search products by name or SKU' : kind === 'category' ? 'Search categories' : 'Search content pages'} type="search" value={search} onChange={e => setSearch(e.target.value)} />
    <Notice error>{query.error?.message}</Notice>{(query.isPending || searching) && <p role="status">Searching…</p>}
    {!searching && <div className="visibility-resource-results">{query.data?.items.map(row => <button type="button" className="secondary" key={row.id} onClick={() => onSelect(row.id, row.name || row.key || 'Page')}><span>{row.name || row.key}<small>{row.sku ? ` · ${row.sku}` : ''}</small></span><span>Add</span></button>)}</div>}
    {!query.isPending && !query.error && !searching && query.data?.items.length === 0 && <p className="help">No matching pages. Try another search.</p>}
    {kind !== 'category' && <div className="visibility-picker-nav"><button type="button" className="secondary" disabled={cursors.length === 1 || query.isFetching || searching} onClick={() => setCursors(values => values.slice(0, -1))}>Previous</button><span className="help">Page {cursors.length}</span><button type="button" className="secondary" disabled={!query.data?.next_cursor || query.isFetching || searching} onClick={() => { if (query.data?.next_cursor) setCursors(values => [...values, query.data!.next_cursor]); }}>Next</button></div>}
  </div>;
}
