import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { catalogApi, segmentsApi } from '@commerce/api-client';
import { Notice } from '@commerce/ui';
function SelectedProduct({ id }: {
    id: string;
}) { const q = useQuery({ queryKey: ['relationship-product', id], queryFn: () => catalogApi.adminProduct(id) }); return <span>{q.data ? `${q.data.name} (${q.data.sku})` : q.isError ? 'Product unavailable' : 'Loading product…'}</span>; }
export function ManualProducts({ ids, onChange }: {
    ids: string[];
    onChange: (ids: string[]) => void;
}) {
    const [offset, setOffset] = useState(0);
    const [filter, setFilter] = useState('');
    const q = useQuery({ queryKey: ['relationship-products', offset], queryFn: () => catalogApi.products(offset) });
    const rows = q.data?.filter(p => `${p.name} ${p.sku}`.toLowerCase().includes(filter.toLowerCase()));
    return <div><h3>Manual products</h3><p>Choose up to 20 products. Their order takes precedence over automatic matches.</p><ol>{ids.map((id, i) => <li key={id}><SelectedProduct id={id}/>{i > 0 && <button type="button" aria-label={`Move product ${i + 1} up`} onClick={() => { const next = [...ids]; [next[i - 1], next[i]] = [next[i], next[i - 1]]; onChange(next); }}>Move up</button>}<button type="button" aria-label={`Remove product ${i + 1}`} onClick={() => onChange(ids.filter(v => v !== id))}>Remove</button></li>)}</ol><label>Filter this page by name or SKU<input value={filter} onChange={e => setFilter(e.target.value)}/></label><Notice error>{q.error?.message}</Notice><select aria-label="Add manual product" value="" disabled={ids.length >= 20 || q.isPending} onChange={e => onChange([...ids, e.target.value])}><option value="">Select a product…</option>{rows?.filter(p => !ids.includes(p.id) && !p.parent_id).map(p => <option value={p.id} key={p.id}>{p.name} · {p.sku}{p.active ? '' : ' (disabled)'}</option>)}</select><div><button type="button" disabled={!offset || q.isFetching} onClick={() => setOffset(offset - 50)}>Previous products</button><button type="button" disabled={(q.data?.length ?? 0) < 50 || q.isFetching} onClick={() => setOffset(offset + 50)}>Next products</button></div></div>;
}
function SelectedSegment({ id }: {
    id: string;
}) { const q = useQuery({ queryKey: ['relationship-segment', id], queryFn: () => segmentsApi.get(id) }); return <span>{q.data?.name ?? (q.isError ? 'Segment unavailable' : 'Loading segment…')}</span>; }
export function SegmentSelection({ ids, onChange, canRead }: {
    ids: string[];
    onChange: (ids: string[]) => void;
    canRead: boolean;
}) {
    const [offset, setOffset] = useState(0);
    const q = useQuery({ queryKey: ['relationship-segments', offset], queryFn: () => segmentsApi.list(offset), enabled: canRead });
    if (!canRead)
        return <p>Audience: {ids.length ? `${ids.length} selected segments` : 'All customers'}. Customer read access is required to change audience selections.</p>;
    return <div><h3>Customer segments</h3><p>Leave empty for everyone. Selected segments require a signed-in customer matching at least one active segment.</p><ul>{ids.map(id => <li key={id}><SelectedSegment id={id}/><button type="button" onClick={() => onChange(ids.filter(v => v !== id))}>Remove segment</button></li>)}</ul><Notice error>{q.error?.message}</Notice><select aria-label="Add customer segment" value="" disabled={ids.length >= 20 || q.isPending} onChange={e => onChange([...ids, e.target.value])}><option value="">Select a segment…</option>{q.data?.filter(s => !ids.includes(s.id)).map(s => <option value={s.id} key={s.id}>{s.name} ({s.status})</option>)}</select><button type="button" disabled={!offset || q.isFetching} onClick={() => setOffset(offset - 50)}>Previous segments</button><button type="button" disabled={(q.data?.length ?? 0) < 50 || q.isFetching} onClick={() => setOffset(offset + 50)}>Next segments</button></div>;
}
