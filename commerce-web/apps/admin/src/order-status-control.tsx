import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { orderStatusesApi, type OrderStatusDisplay } from '@commerce/api-client';
import { Notice } from '@commerce/ui';
import './order-statuses.css';
import { StatusField as Field } from "./order-status-field";
export function OrderStatusControl({ id, state, revision, display, canWrite }: { id: string; state: string; revision: number; display?: OrderStatusDisplay; canWrite: boolean }) {
  const q = useQuery({ queryKey: ['order-statuses'], queryFn: orderStatusesApi.list });
  const history = useQuery({ queryKey: ['order-status-history', id], queryFn: () => orderStatusesApi.history(id) });
  const cache = useQueryClient();
  const [code, setCode] = useState(''), [reason, setReason] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  // Freeze the expected revision with the user's selection; polling must not overwrite stale-edit protection.
  const [expected, setExpected] = useState(revision);
  const options = (q.data || []).filter(r => r.active && r.state === state);
  return <section className="order-status-control" aria-label="Order display status"><h3>Order status</h3><p>Workflow stage: {state.replaceAll('_', ' ')}. Choose a label within this stage; use the order actions to advance it.</p>
    <Notice error>{error || (q.error instanceof Error ? q.error.message : '')}</Notice>
    {canWrite && <form onSubmit={async e => { e.preventDefault(); if (busy) return; setBusy(true); setError(''); try { await orderStatusesApi.assign(id, { code, reason, expected_revision: expected }); setCode(''); setReason(''); await Promise.all([cache.invalidateQueries({ queryKey: ['admin-orders'] }), cache.invalidateQueries({ queryKey: ['order-status-history', id] })]); } catch (err) { setError(err instanceof Error ? err.message : 'Unable to update status.'); } finally { setBusy(false); } }}>
      <Field label="Status label"><select disabled={busy || q.isPending} required value={code} onChange={e => { setCode(e.target.value); setExpected(revision); setError(''); }}><option value="">{display?.label || 'Choose status'}</option>{options.filter(r => r.code !== display?.code).map(r => <option key={r.code} value={r.code}>{r.label}{!r.customer_visible && ' (internal)'}</option>)}</select></Field>
      <Field label="Reason for status change"><input disabled={busy} required minLength={3} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} /></Field><button disabled={busy || !code || !options.some(r => r.code === code) || reason.trim().length < 3}>{busy ? 'Updating…' : 'Update label'}</button>
      {code && expected !== revision && <p role="alert">This order changed. Select a status again to review the latest version.</p>}
    </form>}
    <details><summary>Status label history</summary>{history.isPending ? <p>Loading history…</p> : history.isError ? <p role="alert">Unable to load status history.</p> : history.data?.length ? <ol>{history.data.map(h => <li key={h.id}><strong>{h.previous_label} → {h.label}</strong><p>{h.reason}</p><small>{new Date(h.created_at).toLocaleString()} · Admin {h.actor_id}</small></li>)}</ol> : <p>No manual label changes. Workflow changes appear in the order timeline.</p>}</details>
  </section>;
}
