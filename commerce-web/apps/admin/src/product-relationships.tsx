import { ManualProducts, SegmentSelection } from "./relationship-selectors";
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { relationshipsApi, catalogApi, type RelationshipInput, type RelationshipRule, type RelationshipConditions, type RelationshipCondition } from '@commerce/api-client';
import { Notice } from '@commerce/ui';
import { PageHeader } from './page-header';
import './product-relationships.css';
export const newRelationshipRule = (): RelationshipInput => ({ name: '', kind: 'related', active: false, priority: 1, starts_at: null, ends_at: null, result_limit: 4, stop_processing: false, source: { any: false, conditions: [] }, target: { any: false, conditions: [] }, manual_ids: [], segment_ids: [], revision: 0 });
function Conditions({ title, value, onChange, disabled }: {
    title: string;
    value: RelationshipConditions;
    onChange: (v: RelationshipConditions) => void;
    disabled: boolean;
}) {
    const attributes = useQuery({ queryKey: ['relationship-attributes'], queryFn: relationshipsApi.attributes });
    const categories = useQuery({ queryKey: ['relationship-categories'], queryFn: () => catalogApi.adminCategories() });
    const update = (i: number, patch: Partial<RelationshipCondition>) => onChange({ ...value, conditions: value.conditions.map((c, n) => n === i ? { ...c, ...patch } : c) });
    return <fieldset disabled={disabled}><legend>{title}</legend><label>Match <select value={value.any ? 'any' : 'all'} onChange={e => onChange({ ...value, any: e.target.value === 'any' })}><option value="all">All conditions</option><option value="any">Any condition</option></select></label>{!value.conditions.length && <p>All published products match this group.</p>}{value.conditions.map((c, i) => <div className="relationship-condition" key={i}><select aria-label={`${title} field ${i + 1}`} value={c.field} onChange={e => update(i, { field: e.target.value as RelationshipCondition['field'], operator: 'eq', value: '', attribute_code: undefined })}><option value="sku">SKU</option><option value="category">Category</option><option value="product_type">Product type</option><option value="price">Catalog price</option><option value="attribute">Promotion attribute</option></select>{c.field === 'attribute' && <select aria-label={`${title} attribute ${i + 1}`} required value={c.attribute_code ?? ''} onChange={e => update(i, { attribute_code: e.target.value })}><option value="">Select promotion attribute</option>{attributes.data?.map(a => <option value={a.attribute_code} key={a.attribute_code}>{a.label}</option>)}</select>}<select aria-label={`${title} operator ${i + 1}`} value={c.operator} onChange={e => update(i, { operator: e.target.value as RelationshipCondition['operator'] })}><option value="eq">Is</option><option value="ne">Is not</option>{c.field === 'price' && <><option value="gte">At least</option><option value="lte">At most</option></>}</select>{c.field === 'category' ? <select aria-label={`${title} value ${i + 1}`} value={c.value} onChange={e => update(i, { value: e.target.value })}><option value="">Select category</option>{categories.data?.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select> : c.field === 'product_type' ? <select aria-label={`${title} value ${i + 1}`} value={c.value} onChange={e => update(i, { value: e.target.value })}><option value="">Select type</option>{['simple', 'configurable', 'bundle', 'grouped'].map(t => <option key={t}>{t}</option>)}</select> : <input required aria-label={`${title} value ${i + 1}`} value={c.value} type={c.field === 'price' ? 'number' : 'text'} min={c.field === 'price' ? 0 : undefined} step={c.field === 'price' ? '0.01' : undefined} onChange={e => update(i, { value: e.target.value })}/>}<button type="button" onClick={() => onChange({ ...value, conditions: value.conditions.filter((_, n) => n !== i) })}>Remove</button></div>)}<button type="button" disabled={value.conditions.length >= 20} onClick={() => onChange({ ...value, conditions: [...value.conditions, { field: 'sku', operator: 'eq', value: '' }] })}>Add condition</button></fieldset>;
}
export function ProductRelationships({ canWrite, canReadSegments = false }: {
    canWrite: boolean;
    canReadSegments?: boolean;
}) {
    const cache = useQueryClient();
    const list = useQuery({ queryKey: ['relationship-rules'], queryFn: relationshipsApi.list });
    const [draft, setDraft] = useState<RelationshipInput | null>(null);
    const [id, setId] = useState<string>();
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    function edit(rule?: RelationshipRule) { setDraft(rule ? { name: rule.name, kind: rule.kind, active: rule.active, priority: rule.priority, starts_at: rule.starts_at, ends_at: rule.ends_at, result_limit: rule.result_limit, stop_processing: rule.stop_processing, source: rule.source, target: rule.target, manual_ids: rule.manual_ids, segment_ids: rule.segment_ids, revision: rule.revision } : newRelationshipRule()); setId(rule?.id); setError(''); setConfirmDelete(false); }
    const patch = (p: Partial<RelationshipInput>) => setDraft(draft ? { ...draft, ...p } : draft);
    async function save() { if (!draft)
        return; setBusy(true); setError(''); try {
        await relationshipsApi.save(draft, id);
        await cache.invalidateQueries({ queryKey: ['relationship-rules'] });
        setDraft(null);
    }
    catch (e) {
        setError((e as Error).message + ' If another administrator changed this rule, close and reopen it before saving.');
    }
    finally {
        setBusy(false);
    } }
    async function remove() { if (!id || !draft)
        return; setBusy(true); try {
        await relationshipsApi.delete(id, draft.revision);
        await cache.invalidateQueries({ queryKey: ['relationship-rules'] });
        setDraft(null);
    }
    catch (e) {
        setError((e as Error).message);
    }
    finally {
        setBusy(false);
    } }
    return <main className="relationship-admin"><PageHeader title="Product relationship rules"/><p>Configure related products, up-sells on product pages, and cross-sells in the cart. Lower priority numbers run first. Manual selections take precedence; unavailable products and products already in the source list are excluded.</p><Notice error>{error || list.error?.message}</Notice>{list.isPending && <p role="status">Loading rules…</p>}{!draft ? <><button disabled={!canWrite || list.isPending} onClick={() => edit()}>Add rule</button><table><thead><tr><th>Name</th><th>Relationship</th><th>Status</th><th>Priority</th><th>Limit</th><th>Action</th></tr></thead><tbody>{list.data?.map(r => <tr key={r.id}><td>{r.name}</td><td>{r.kind.replace('_', ' ')}</td><td>{r.active ? 'Enabled' : 'Disabled'}</td><td>{r.priority}</td><td>{r.result_limit}</td><td><button onClick={() => edit(r)}>{canWrite ? 'Edit' : 'View'}</button></td></tr>)}</tbody></table>{list.data?.length === 0 && <p>No rules yet. New rules start disabled so you can review them before activation.</p>}</> : <form onSubmit={e => { e.preventDefault(); void save(); }}><fieldset disabled={!canWrite || busy}><legend>Rule information</legend><label>Name<input required maxLength={120} value={draft.name} onChange={e => patch({ name: e.target.value })}/></label><label>Relationship<select value={draft.kind} onChange={e => patch({ kind: e.target.value as RelationshipInput['kind'] })}><option value="related">Related products</option><option value="upsell">Up-sells</option><option value="cross_sell">Cross-sells</option></select></label><label>Priority<input type="number" required min={1} max={2147483647} value={draft.priority} onChange={e => patch({ priority: Number(e.target.value) })}/></label><label>Result limit<input type="number" required min={1} max={20} value={draft.result_limit} onChange={e => patch({ result_limit: Number(e.target.value) })}/></label><label><input type="checkbox" checked={draft.active} onChange={e => patch({ active: e.target.checked })}/>Enabled</label><label><input type="checkbox" checked={draft.stop_processing} onChange={e => patch({ stop_processing: e.target.checked })}/>Stop lower-priority rules after a source match</label>{(['starts_at', 'ends_at'] as const).map(key => <label key={key}>{key === 'starts_at' ? 'Start (UTC, inclusive)' : 'End (UTC, exclusive)'}<input type="datetime-local" value={draft[key]?.slice(0, 16) || ''} onChange={e => patch({ [key]: e.target.value ? `${e.target.value}:00Z` : null })}/></label>)}</fieldset><Conditions title="Products to match" value={draft.source} onChange={source => patch({ source })} disabled={!canWrite || busy}/><Conditions title="Products to display" value={draft.target} onChange={target => patch({ target })} disabled={!canWrite || busy}/><fieldset disabled={!canWrite || busy}><legend>Manual selection and audience</legend><ManualProducts ids={draft.manual_ids} onChange={manual_ids => patch({ manual_ids })}/><p>Manual selections bypass display conditions, but must be published and available.</p><SegmentSelection ids={draft.segment_ids} onChange={segment_ids => patch({ segment_ids })} canRead={canReadSegments}/></fieldset><div className="relationship-actions"><button disabled={!canWrite || busy} type="submit">{busy ? 'Saving…' : 'Save rule'}</button><button type="button" disabled={busy} onClick={() => setDraft(null)}>Close</button>{id && canWrite && <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)}>Delete rule</button>}</div>{confirmDelete && <div role="alert"><p>Delete “{draft.name}”? This removes the rule from storefront evaluation.</p><button type="button" disabled={busy} onClick={() => void remove()}>Confirm delete</button><button type="button" onClick={() => setConfirmDelete(false)}>Cancel</button></div>}</form>}</main>;
}
