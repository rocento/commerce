import { useState } from 'react';
import { Notice } from '@commerce/ui';
import { PageHeader } from './page-header';
import { ExportTools, useGrid } from './grids';
import { auditDateRange } from './access-review';
import { auditEntityLabel, shortAuditId } from './audit-labels';
import './access-management.css';

type AuditFilters = { action?: string; actor_id?: string; entity_id?: string; created_from?: string; created_to?: string };
const empty = { action: '', actor_id: '', entity_id: '', from: '', to: '' };
const labels: Record<string, string> = { action: 'Action', actor_id: 'Actor ID', entity_id: 'Entity ID', created_from: 'From', created_to: 'Until' };
export function AuditLog() {
  const [draft, setDraft] = useState(empty);
  const [filters, setFilters] = useState<AuditFilters>({});
  const [error, setError] = useState('');
  const [utc, setUtc] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const q = useGrid('audit', ['audit'], filters, true, { initialSort: 'created_at', initialDescending: true });
  const clear = () => { setFilters({}); setDraft(empty); setError(''); };
  return <main className="access-management">
    <PageHeader title="Audit log" description="Investigate administrative activity with searchable, timestamped change records." actions={<button className="secondary" aria-expanded={exportOpen} onClick={() => setExportOpen(!exportOpen)}>{exportOpen ? 'Close export' : 'Export results'}</button>} />
    <div className="access-summary"><span><strong>{q.page?.total_count?.toLocaleString() ?? '—'}</strong> matching events</span><span>Newest first by default</span><label><input type="checkbox" checked={utc} onChange={e => setUtc(e.target.checked)} /> Show UTC</label></div>
    <details className="panel audit-filter-panel"><summary>Investigation filters{Object.keys(filters).length ? ` · ${Object.keys(filters).length} applied` : ''}</summary>
      <form onSubmit={event => {
        event.preventDefault();
        try {
          const dates = auditDateRange(draft.from, draft.to);
          setFilters(Object.fromEntries(Object.entries({ action: draft.action.trim(), actor_id: draft.actor_id.trim(), entity_id: draft.entity_id.trim(), ...dates }).filter(([, value]) => !!value)));
          setError('');
        } catch (cause) { setError(cause instanceof Error ? cause.message : 'Invalid filters'); }
      }}>
        <div className="access-filter-grid">{(['action', 'actor_id', 'entity_id'] as const).map(key => <label key={key}>{labels[key]}<input value={draft[key]} maxLength={key === 'action' ? 200 : 36} pattern={key === 'action' ? undefined : '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'} placeholder={key === 'action' ? 'e.g. admin.role_updated' : 'Full UUID'} onChange={e => setDraft({ ...draft, [key]: e.target.value })} /></label>)}
        <label>From (local time, inclusive)<input type="datetime-local" value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })}/></label>
        <label>Until (local time, exclusive)<input type="datetime-local" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })}/></label></div>
        <Notice error>{error}</Notice><div className="access-buttons"><button>Apply filters</button><button type="button" className="secondary" onClick={clear}>Reset investigation filters</button></div>
      </form>
    </details>
    {q.renderControls({ chips: Object.entries(filters).map(([key, value]) => ({ label: `${labels[key]}: ${value}`, remove: () => {
      setFilters(current => { const next = { ...current }; delete next[key as keyof AuditFilters]; return next; });
      setDraft(current => ({ ...current, [key === 'created_from' ? 'from' : key === 'created_to' ? 'to' : key]: '' }));
    } })), clearFilters: clear })}
    {exportOpen && <section className="panel"><ExportTools grid="audit" filters={q.filters}/></section>}
    <Notice error>{q.error?.message}</Notice>
    {q.isPending ? <p role="status">Loading audit history…</p> : q.data?.length === 0 ? <section className="panel access-empty"><h2>No matching events</h2><p>Try a broader date range or clear the search and filters.</p></section> : q.data && <div className="table-wrap"><table className="audit-table"><thead><tr><th scope="col">Time ({utc ? 'UTC' : 'local'})</th><th scope="col">Action</th><th scope="col">Actor</th><th scope="col">Entity</th><th scope="col">Evidence</th></tr></thead><tbody>
      {q.data.map(event => {
        const entity = auditEntityLabel(event);
        const actor = event.actor_name || event.actor_email || 'Unknown administrator';
        return <tr key={event.id}>
        <td><time dateTime={event.created_at} title={event.created_at}>{utc ? new Date(event.created_at).toISOString().replace('T', ' ').replace('Z', ' UTC') : new Date(event.created_at).toLocaleString()}</time></td>
        <td><code>{event.action}</code></td>
        <td>{event.actor_id ? <button className="text-button audit-reference" title={`Filter by this actor · ${event.actor_id}`} onClick={() => { setFilters(current => ({ ...current, actor_id: event.actor_id! })); setDraft(current => ({ ...current, actor_id: event.actor_id! })); }}><span>{actor}</span><small>{event.actor_email && event.actor_email !== actor ? event.actor_email : shortAuditId(event.actor_id)}</small></button> : <span className="muted">System / bootstrap</span>}</td>
        <td><button className="text-button audit-reference" title={`Filter by this entity · ${event.entity_id}`} onClick={() => { setFilters(current => ({ ...current, entity_id: event.entity_id })); setDraft(current => ({ ...current, entity_id: event.entity_id })); }}><span>{entity.name}</span><small>{entity.context}</small></button></td>
        <td><details><summary>View event</summary><div className="audit-evidence"><p>Event ID <code>{event.id}</code></p><p>Actor ID <code>{event.actor_id || 'System / bootstrap'}</code></p><p>Entity ID <code>{event.entity_id}</code></p><p>Recorded at <code>{event.created_at}</code></p><pre>{JSON.stringify(event.details, null, 2)}</pre></div></details></td>
      </tr>; })}
    </tbody></table></div>}
  </main>;
}
