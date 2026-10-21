import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { orderStatusesApi, type OrderStatusDefinition, type OrderStatusInput } from '@commerce/api-client';
import { Notice } from '@commerce/ui';
import { PageHeader } from './page-header';
import { useUnsavedChanges } from './unsaved-changes';
import './order-statuses.css';
import { StatusField as Field } from "./order-status-field";

const stages: Record<OrderStatusInput['state'], string> = { placed: 'New order', confirmed: 'Confirmed', fulfilling: 'Fulfillment in progress', shipped: 'Shipped', delivered: 'Delivered', cash_collected: 'Complete · cash collected', cancelled: 'Canceled', delivery_failed: 'Delivery failed', pickup_ready: 'Ready for pickup', picked_up: 'Picked up' };
const blank = (): OrderStatusInput => ({ code: '', state: 'placed', label: '', translations: {}, description: '', tone: 'neutral', customer_visible: true, is_default: false, active: true, expected_revision: 0, reason: '' });
const fromRecord = (r: OrderStatusDefinition): OrderStatusInput => ({ code: r.code, state: r.state, label: r.label, translations: r.translations, description: r.description, tone: r.tone, customer_visible: r.customer_visible, is_default: r.is_default, active: r.active, expected_revision: r.revision, reason: '' });
export function OrderStatuses({ canManage }: { canManage: boolean }) {
  const cache = useQueryClient();
  const q = useQuery({ queryKey: ['order-statuses'], queryFn: orderStatusesApi.list });
  const [editor, setEditor] = useState<{ record?: OrderStatusDefinition; initial: OrderStatusInput; draft: OrderStatusInput }>();
  const [search, setSearch] = useState(''), [stage, setStage] = useState(''), [includeArchived, setIncludeArchived] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const dirty = !!editor && JSON.stringify(editor.initial) !== JSON.stringify(editor.draft);
  useUnsavedChanges(dirty);
  function open(record?: OrderStatusDefinition) {
    if (dirty && !window.confirm('Discard unsaved status changes?')) return;
    const initial = record ? fromRecord(record) : blank();
    setEditor({ record, initial, draft: initial }); setError(''); setMessage('');
  }
  function close() { if (!dirty || window.confirm('Discard unsaved status changes?')) { setEditor(undefined); setError(''); } }
  function update(patch: Partial<OrderStatusInput>) { setEditor(e => e && ({ ...e, draft: { ...e.draft, ...patch } })); }
  async function save(event: React.FormEvent) {
    event.preventDefault(); if (!editor || busy) return; setBusy(true); setError('');
    try { await orderStatusesApi.save(editor.draft, editor.record?.code); setEditor(undefined); setMessage('Order status saved. Existing orders keep their assigned status; label edits appear immediately.'); await cache.invalidateQueries({ queryKey: ['order-statuses'] }); await cache.invalidateQueries({ queryKey: ['admin-orders'] }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to save status.'); }
    finally { setBusy(false); }
  }
  const rows = (q.data || []).filter(r => (includeArchived || r.active) && (!stage || r.state === stage) && `${r.label} ${r.code}`.toLowerCase().includes(search.toLowerCase()));
  const d = editor?.draft;
  return <main className="order-statuses-page">
    <PageHeader title="Order statuses" description="Use clear labels for each stage of an order, with standard defaults and custom statuses for your team." actions={canManage && <button className="primary" disabled={busy} onClick={() => open()}>Add status</button>} />
    <p className="status-explanation">Each status belongs to a workflow stage. Order actions control fulfillment and payment. Changing a label does not ship, cancel, refund or collect payment.</p>
    <Notice error={!!error || q.isError}>{error || (q.error instanceof Error ? q.error.message : '') || message}</Notice>
    {!canManage && <p>You have read-only access to order statuses.</p>}
    {editor && d && <form className="status-editor" onSubmit={save} aria-label={editor.record ? 'Edit order status' : 'Add order status'}>
      <h2>{editor.record ? `Edit ${editor.record.label}` : 'Add order status'}</h2>
      <fieldset disabled={busy}><div className="status-fields">
        <Field label="Label"><input required maxLength={80} value={d.label} onChange={e => update({ label: e.target.value })} /></Field>
        <Field label="Code"><input aria-label="Code" required pattern="[a-z][a-z0-9_]{1,47}" maxLength={48} disabled={!!editor.record} value={d.code} onChange={e => update({ code: e.target.value })} /><small>Permanent lowercase identifier, such as picking.</small></Field>
        <Field label="Workflow stage"><select disabled={!!editor.record} value={d.state} onChange={e => update({ state: e.target.value as OrderStatusInput['state'] })}>{Object.entries(stages).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field>
        <Field label="Color"><select value={d.tone} onChange={e => update({ tone: e.target.value as OrderStatusInput['tone'] })}>{['neutral', 'info', 'success', 'warning', 'danger'].map(t => <option key={t}>{t}</option>)}</select></Field>
        <Field label="Description"><textarea maxLength={500} value={d.description} onChange={e => update({ description: e.target.value })} /></Field>
      </div>
      <details><summary>Translated labels ({Object.keys(d.translations).length})</summary>
        {Object.entries(d.translations).map(([locale, value]) => <div key={locale} className="status-translation"><Field label={`Label (${locale})`}><input required maxLength={80} value={value} onChange={e => update({ translations: { ...d.translations, [locale]: e.target.value } })} /></Field><button type="button" aria-label={`Remove ${locale} translation`} onClick={() => { const translations = { ...d.translations }; delete translations[locale]; update({ translations }); }}>Remove</button></div>)}
        <TranslationAdder locales={Object.keys(d.translations)} add={locale => update({ translations: { ...d.translations, [locale]: d.label } })} />
      </details>
      <label className="status-check"><input type="checkbox" checked={d.customer_visible} disabled={d.is_default} onChange={e => update({ customer_visible: e.target.checked })} />Visible to customers</label>
      <small>Internal statuses show the stage’s default label to customers.</small>
      <label className="status-check"><input type="checkbox" checked={d.is_default} disabled={editor.record?.is_default} onChange={e => update({ is_default: e.target.checked, ...(e.target.checked ? { active: true, customer_visible: true } : {}) })} />Default for this stage</label>
      <small>Applied when an order next enters this stage. To replace a default, choose another status as default.</small>
      <label className="status-check"><input type="checkbox" checked={d.active} disabled={editor.record?.is_system || d.is_default} onChange={e => update({ active: e.target.checked })} />Active</label>
      <small>Archived statuses stay on existing orders but cannot be assigned again. Built-in statuses remain active.</small>
      <Field label="Reason for change"><textarea required minLength={3} maxLength={500} value={d.reason} onChange={e => update({ reason: e.target.value })} /></Field>
      <div className="status-buttons"><button className="primary" disabled={!canManage}>{busy ? 'Saving…' : 'Save status'}</button><button type="button" onClick={close}>Cancel</button>{editor.record && <button type="button" onClick={async () => { if (dirty && !window.confirm('Discard your edits and reload this status?')) return; const fresh = await q.refetch(); const record = fresh.data?.find(r => r.code === editor.record?.code); if (record) { const initial = fromRecord(record); setEditor({ record, initial, draft: initial }); setError(''); } }}>Reload latest</button>}</div>
      </fieldset>
    </form>}
    <div className="status-filters"><Field label="Search statuses"><input type="search" value={search} onChange={e => setSearch(e.target.value)} /></Field><Field label="Filter by stage"><select value={stage} onChange={e => setStage(e.target.value)}><option value="">All stages</option>{Object.entries(stages).map(([k,v]) => <option key={k} value={k}>{v}</option>)}</select></Field><label className="status-check"><input type="checkbox" checked={includeArchived} onChange={e => setIncludeArchived(e.target.checked)} />Include archived</label></div>
    {q.isPending ? <p>Loading order statuses…</p> : <div className="status-table"><table><thead><tr><th>Status</th><th>Workflow stage</th><th>Customer visibility</th><th>Usage</th>{canManage && <th>Actions</th>}</tr></thead><tbody>{rows.map(r => <tr key={r.code}><td><span className={`order-status-label tone-${r.tone}`}>{r.label}</span><small>{r.code}{r.description && ` · ${r.description}`}</small></td><td>{stages[r.state]}</td><td>{r.customer_visible ? 'Visible' : 'Internal only'}</td><td>{[r.is_default && 'Default', r.is_system && 'Built-in', !r.active && 'Archived'].filter(Boolean).join(' · ') || 'Custom'}</td>{canManage && <td><button disabled={busy} onClick={() => open(r)} aria-label={`Edit ${r.label}`}>Edit</button></td>}</tr>)}</tbody></table>{rows.length === 0 && <p>No matching statuses.</p>}</div>}
  </main>;
}
function TranslationAdder({ locales, add }: { locales: string[]; add: (locale: string) => void }) {
  const [locale, setLocale] = useState('');
  return <div className="status-translation"><Field label="Language code"><input placeholder="ar or en-GB" value={locale} onChange={e => setLocale(e.target.value)} /></Field><button type="button" disabled={!/^[a-zA-Z]{2,8}(-[a-zA-Z]{2,8})?$/.test(locale) || locale.length > 16 || locales.includes(locale) || locales.length >= 50} onClick={() => { add(locale); setLocale(''); }}>Add translation</button></div>;
}
