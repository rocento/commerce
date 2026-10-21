import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, adminCustomerApi, marketingNotificationApi, type GeneratedNotification, type NotificationMetadata, type NotificationPreview, type NotificationProgram, type NotificationProgramInput } from '@commerce/api-client';
import { Notice } from '@commerce/ui';
import { PageHeader } from './page-header';
import { useUnsavedChanges } from './unsaved-changes';
import { NotificationPublicationManager, PublishGeneratedNotification } from './notification-publications';
import './marketing-notifications.css';
import { NotificationConditionsEditor, NotificationConditionResults } from './notification-conditions';
import { normalizeNotificationConditions, notificationConditionProblems, notificationProgramSummary, notificationTemplateOutline } from './notification-condition-model';

type Access = { canWrite: boolean; canGenerate: boolean; canPublish: boolean; canReadCustomers: boolean; canReadOrders: boolean };
type Workspace = { key: string; program: NotificationProgram | null; preset?: Partial<NotificationProgramInput> };
const PAGE_SIZE = 12;
const statuses: NotificationProgramInput['status'][] = ['draft', 'active', 'paused', 'archived'];
const tabs = [{ id: 'program', label: 'Program' }, { id: 'preview', label: 'Preview & generate' }, { id: 'history', label: 'Generated history' }, { id: 'audit', label: 'Audit trail' }] as const;
type Tab = typeof tabs[number]['id'];
const label = (value: string) => value.replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
const timestamp = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const validCustomerId = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const errorMessage = (value: unknown) => value instanceof Error ? value.message : 'This action could not be completed. Please try again.';
const inputOf = (program: NotificationProgram): NotificationProgramInput => ({ name: program.name, description: program.description, channel: program.channel, trigger_kind: program.trigger_kind, title_template: program.title_template, body_template: program.body_template, status: program.status, delay_minutes: program.delay_minutes, lookback_days: program.lookback_days, cooldown_hours: program.cooldown_hours, suppress_after_purchase: program.suppress_after_purchase, conditions: normalizeNotificationConditions(program.conditions) });
const emptyProgram = (metadata: NotificationMetadata): NotificationProgramInput => ({ name: '', description: '', channel: 'in_app', trigger_kind: metadata.triggers[0]?.id ?? '', title_template: '', body_template: '', status: 'draft', delay_minutes: 0, lookback_days: 30, cooldown_hours: 24, suppress_after_purchase: false, conditions: normalizeNotificationConditions() });
function starterProgram(trigger: NotificationMetadata['triggers'][number]): Partial<NotificationProgramInput> {
  const common = { trigger_kind: trigger.id, status: 'draft' as const };
  if (trigger.id === 'cart.item_added') return { ...common, name: 'A helpful cart reminder', description: 'Follow up on saved cart activity when no later order has been placed.', title_template: 'Still thinking it over, {{customer.first_name}}?', body_template: 'You added {{product.name}} to your cart. Take another look whenever you are ready.', delay_minutes: 60, suppress_after_purchase: true };
  if (trigger.id === 'product_view') return { ...common, name: 'Continue the discovery', description: 'A personal follow-up to a product the customer explored.', title_template: 'A second look, {{customer.first_name}}?', body_template: 'You recently explored {{product.name}}. We are here to help you find the right fit.', delay_minutes: 120, suppress_after_purchase: true };
  if (trigger.id === 'purchase') return { ...common, name: 'Thank you for your order', description: 'A personalized acknowledgement of a recorded order placement.', title_template: 'Thank you, {{customer.first_name}}', body_template: 'We received your order {{order.number}} for {{order.total}} {{order.currency}}. Thank you for shopping with us.', cooldown_hours: 0, suppress_after_purchase: false };
  return { ...common, name: trigger.label, description: `Personalized communication after ${trigger.label.toLowerCase()}.`, title_template: 'Welcome back, {{customer.first_name}}', body_template: 'Thanks for exploring our store. We are here to help with your next step.' };
}

function BellIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/><path d="M12 2V1"/></svg>;
}
function AccessMessage() {
  return <div className="mn-empty mn-access"><h3>Customer activity access is required</h3><p>Customer and Orders read permissions are needed to preview personalized content and view generated records.</p></div>;
}
function Pagination({ offset, total, count, busy, onChange, name }: { offset: number; total: number; count: number; busy: boolean; onChange: (offset: number) => void; name: string }) {
  return <nav className="mn-pagination" aria-label={`${name} pages`}><span>{total ? `${offset + 1}–${offset + count} of ${total}` : '0 results'}</span><div><button type="button" className="secondary" aria-label={`Previous ${name} page`} disabled={busy || offset === 0} onClick={() => onChange(Math.max(0, offset - PAGE_SIZE))}>←</button><button type="button" className="secondary" aria-label={`Next ${name} page`} disabled={busy || offset + count >= total} onClick={() => onChange(offset + PAGE_SIZE)}>→</button></div></nav>;
}

export function MarketingNotifications(access: Access) {
  const [search, setSearch] = useState(''), [appliedSearch, setAppliedSearch] = useState('');
  const [status, setStatus] = useState<NotificationProgramInput['status'] | ''>(''), [offset, setOffset] = useState(0);
  const [workspace, setWorkspace] = useState<Workspace | null>(null), [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false);
  const [workspaceParams] = useSearchParams();
  const [showTemplates, setShowTemplates] = useState(() => workspaceParams.get('workspace') === 'journeys' || workspaceParams.has('customer_id')); 
  const [publicationDirty, setPublicationDirty] = useState(false), [publicationBusy, setPublicationBusy] = useState(false);
  useUnsavedChanges(dirty || busy || publicationDirty || publicationBusy);
  const metadata = useQuery({ queryKey: ['notification-metadata'], queryFn: () => marketingNotificationApi.metadata(), retry: false });
  const library = useQuery({ queryKey: ['notification-programs', appliedSearch, status, offset], queryFn: () => marketingNotificationApi.list({ search: appliedSearch || undefined, status: status || undefined, offset, limit: PAGE_SIZE }), enabled: showTemplates, retry: false });
  useEffect(() => { const timer = window.setTimeout(() => { setAppliedSearch(search.trim()); setOffset(0); }, 300); return () => window.clearTimeout(timer); }, [search]);
  const items = library.data?.programs ?? [];
  const starterTriggers = metadata.data ? ['cart.item_added', 'product_view', 'purchase'].flatMap(id => metadata.data!.triggers.filter(trigger => trigger.id === id)) : [];
  function open(program: NotificationProgram | null, preset?: Partial<NotificationProgramInput>) {
    if (busy || publicationBusy || (program && workspace?.program?.id === program.id)) return;
    if (dirty && !window.confirm('Discard unsaved notification changes and open another program?')) return;
    setDirty(false); setShowTemplates(true); setWorkspace({ key: program?.id ?? crypto.randomUUID(), program, preset });
  }
  return <main className="mn-page">
    <PageHeader title="Notifications" description="Build one campaign around your audience, their journey, and the right moment to reach them." actions={!access.canWrite && !access.canPublish ? <span className="mn-access-label">View only</span> : undefined}/>
    <NotificationPublicationManager canPublish={access.canPublish} canWrite={access.canWrite} canReadCustomers={access.canReadCustomers} canReadOrders={access.canReadOrders} onDirtyChange={setPublicationDirty} onBusyChange={setPublicationBusy}/>
    <section className="mn-template-archive" aria-label="Journey templates and generated history">
      <div className="mn-template-archive-heading"><div><h2>Journey templates & history</h2><p>Access existing personalized templates, customer previews, generated messages and audit trails.</p></div><button className="secondary" aria-expanded={showTemplates} aria-controls="journey-template-workspace" disabled={busy || publicationBusy} onClick={() => setShowTemplates(current => !current)}>{showTemplates ? 'Hide templates' : 'Browse templates'}</button></div>
      <div id="journey-template-workspace" hidden={!showTemplates}>
      <div className="mn-template-actions"><p>Saved templates support manual previews and generation. Use a campaign above to deliver automatically to an audience.</p>{access.canWrite && <button className="secondary" disabled={busy || publicationBusy || !metadata.data} onClick={() => open(null)}>New journey template</button>}</div>
    <p className="mn-workflow-note"><span aria-hidden="true">①</span> Choose an event <b>→</b> Add conditions <b>→</b> Write the message <b>→</b> Preview a sample. <span>Template previews do not publish.</span></p>
    {metadata.isPending && <p className="mn-loading" role="status">Loading notification configuration…</p>}
    {metadata.error && <Notice error>{metadata.error.message} <button className="secondary" onClick={() => void metadata.refetch()}>Retry configuration</button></Notice>}
    <div className="mn-workspace">
      <aside className="mn-library" aria-label="Notification programs"><div className="mn-section-heading"><h2>Programs</h2><span>{library.data?.total ?? '—'}</span></div>
        <label className="field">Search programs<input type="search" placeholder="Find a program…" value={search} onChange={event => setSearch(event.target.value)}/></label>
        <label className="field">Filter by status<select value={status} onChange={event => { setStatus(event.target.value as typeof status); setOffset(0); }}><option value="">All statuses</option>{statuses.map(value => <option key={value} value={value}>{label(value)}</option>)}</select></label>
        <div className="mn-library-meta"><span>{library.isFetching ? 'Updating programs…' : 'Latest updated first'}</span><button className="text-button" disabled={library.isFetching} onClick={() => void library.refetch()}>Refresh</button></div>
        {library.error && <Notice error>{library.error.message}<button className="secondary" onClick={() => void library.refetch()}>Retry programs</button></Notice>}
        {library.isPending && <p role="status" className="mn-loading">Loading programs…</p>}
        <div className="mn-program-list">{items.map(program => <button key={program.id} className="mn-program-card" aria-pressed={workspace?.program?.id === program.id} disabled={busy} onClick={() => open(program)}><span className="mn-program-channel">{metadata.data?.channels.find(channel => channel.id === program.channel)?.label || label(program.channel)}</span><strong>{program.name}</strong><span className="mn-program-trigger">{metadata.data?.triggers.find(trigger => trigger.id === program.trigger_kind)?.label || label(program.trigger_kind)}</span><span className="mn-program-bottom"><span className="mn-status" data-status={program.status}>{label(program.status)}</span><small>v{program.version}</small></span></button>)}</div>
        {library.data && !items.length && <div className="mn-empty mn-library-empty"><h3>{appliedSearch || status ? 'No matching programs' : 'Your first program starts here'}</h3><p>{appliedSearch || status ? 'Try another search or status.' : 'Save a journey trigger and message to begin.'}</p>{(appliedSearch || status) && <button className="secondary" onClick={() => { setSearch(''); setAppliedSearch(''); setStatus(''); setOffset(0); }}>Clear filters</button>}</div>}
        {library.data && <Pagination name="programs" offset={offset} count={items.length} total={library.data.total} busy={library.isFetching || busy} onChange={setOffset}/>}
        <p className="mn-library-footnote">Active programs are available for manual generation. No background runs are scheduled.</p>
      </aside>
      <div className="mn-detail">{workspace && metadata.data ? <ProgramEditor key={workspace.key} {...access} initial={workspace.program} preset={workspace.preset} metadata={metadata.data} onDirtyChange={setDirty} onBusyChange={setBusy} onSaved={program => setWorkspace(current => current ? { ...current, program } : current)}/> : <section className="mn-welcome"><span className="mn-welcome-icon"><BellIcon/></span><span className="mn-eyebrow">BUILD A MORE PERSONAL EXPERIENCE</span><h2>Every journey has a next step</h2><p>Use recorded activity to prepare a relevant message for each customer. Select a program or start with a moment below.</p><ol className="mn-steps"><li><b>01</b><div><strong>Choose the moment</strong><span>Connect a program to an existing journey event.</span></div></li><li><b>02</b><div><strong>Make it personal</strong><span>Use customer and activity variables in your message.</span></div></li><li><b>03</b><div><strong>Review the result</strong><span>Preview eligibility and save a generated record.</span></div></li></ol>{access.canWrite && metadata.data && <div className="mn-starters"><h3>Start from a journey moment</h3>{(starterTriggers.length ? starterTriggers : metadata.data.triggers.slice(0, 3)).map(trigger => <button className="secondary" key={trigger.id} onClick={() => open(null, starterProgram(trigger))}><span>{trigger.label}</span><span aria-hidden="true">↗</span></button>)}</div>}</section>}</div>
    </div>
    </div>
    </section>
  </main>;
}

function ProgramEditor({ initial, preset, metadata, canWrite, canGenerate, canPublish, canReadCustomers, canReadOrders, onDirtyChange, onBusyChange, onSaved }: Access & { initial: NotificationProgram | null; preset?: Partial<NotificationProgramInput>; metadata: NotificationMetadata; onDirtyChange: (value: boolean) => void; onBusyChange: (value: boolean) => void; onSaved: (program: NotificationProgram) => void }) {
  const cache = useQueryClient(), fieldId = useId(), [searchParams] = useSearchParams();
  const [record, setRecord] = useState(initial);
  const [baseline, setBaseline] = useState<NotificationProgramInput>(() => initial ? inputOf(initial) : emptyProgram(metadata));
  const [form, setForm] = useState<NotificationProgramInput>(() => initial ? inputOf(initial) : { ...emptyProgram(metadata), ...preset });
  const [tab, setTab] = useState<Tab>('program'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [conflict, setConflict] = useState(false);
  const [customerSearch, setCustomerSearch] = useState(''), [appliedCustomerSearch, setAppliedCustomerSearch] = useState('');
  const [customerInput, setCustomerInput] = useState(searchParams.get('customer_id') ?? '');
  const [customerId, setCustomerId] = useState(() => validCustomerId(searchParams.get('customer_id') ?? '') ? searchParams.get('customer_id')! : '');
  const [customerError, setCustomerError] = useState('');
  const [preview, setPreview] = useState<{ snapshot: string; value: NotificationPreview } | null>(null), [previewError, setPreviewError] = useState(''), [previewPending, setPreviewPending] = useState(false), [previewRefresh, setPreviewRefresh] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [publishingRecord, setPublishingRecord] = useState<GeneratedNotification | null>(null), [publicationDirty, setPublicationDirty] = useState(false), [publicationBusy, setPublicationBusy] = useState(false);
  const tabRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const contentRefs = useRef<Partial<Record<'title_template' | 'body_template', HTMLInputElement | HTMLTextAreaElement | null>>>({});
  const focusedContent = useRef<'title_template' | 'body_template'>('body_template');
  const generationRequest = useRef<{ snapshot: string; key: string } | null>(null);
  const operationPending = useRef(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);
  const canInspect = canReadCustomers && canReadOrders;
  const canEdit = canWrite && record?.status !== 'archived';
  const problems = programProblems(form, metadata);
  useEffect(() => { onDirtyChange(dirty || publicationDirty); return () => onDirtyChange(false); }, [dirty, publicationDirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy || publicationBusy); return () => onBusyChange(false); }, [busy, publicationBusy, onBusyChange]);
  useEffect(() => { const timer = window.setTimeout(() => setAppliedCustomerSearch(customerSearch.trim()), 300); return () => window.clearTimeout(timer); }, [customerSearch]);
  const customers = useQuery({ queryKey: ['notification-customer-search', appliedCustomerSearch], queryFn: ({ signal }) => marketingNotificationApi.customers({ search: appliedCustomerSearch }, signal), enabled: canInspect && tab === 'preview' && appliedCustomerSearch.length >= 2, retry: false });
  const customer = useQuery({ queryKey: ['notification-customer', customerId], queryFn: () => adminCustomerApi.profile(customerId), enabled: canInspect && !!customerId && tab === 'preview', retry: false });
  const history = useQuery({ queryKey: ['notification-records', record?.id, historyOffset], queryFn: () => marketingNotificationApi.records({ program_id: record!.id, offset: historyOffset, limit: PAGE_SIZE }), enabled: tab === 'history' && !!record && canInspect, retry: false });
  const audit = useQuery({ queryKey: ['notification-audit', record?.id], queryFn: () => marketingNotificationApi.audit(record!.id), enabled: tab === 'audit' && !!record, retry: false });
  const snapshot = JSON.stringify([form, record?.id, record?.version, customerId, customerInput.trim(), previewRefresh]);
  const currentPreview = preview?.snapshot === snapshot ? preview.value : null;
  const customerReady = customerId !== '' && customerInput.trim() === customerId && !!customer.data && !customer.error;
  const previewAllowed = canInspect && customerReady && !problems.length;
  const generationReady = canGenerate && !!record && !dirty && !conflict && record.status === 'active' && previewAllowed && !!currentPreview?.eligible && !previewPending && !busy;
  useEffect(() => {
    setPreview(null); setPreviewError('');
    if (tab !== 'preview' || !previewAllowed) { setPreviewPending(false); return; }
    let cancelled = false;
    const controller = new AbortController();
    setPreviewPending(true);
    const timer = window.setTimeout(() => {
      void marketingNotificationApi.preview({ program: form, customer_id: customerId, ...(record ? { program_id: record.id } : {}) }, controller.signal).then(value => {
        if (!cancelled) setPreview({ snapshot, value });
      }).catch(value => { if (!cancelled) setPreviewError(errorMessage(value)); }).finally(() => { if (!cancelled) setPreviewPending(false); });
    }, 400);
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timer); };
  }, [snapshot, tab, previewAllowed, form, customerId, record]);
  function update<Key extends keyof NotificationProgramInput>(key: Key, value: NotificationProgramInput[Key]) { setForm(current => ({ ...current, [key]: value })); setMessage(''); if (!conflict) setError(''); }
  function insertToken(key: string) {
    const field = focusedContent.current, element = contentRefs.current[field], value = form[field];
    const start = element?.selectionStart ?? value.length, end = element?.selectionEnd ?? value.length, token = `{{${key}}}`;
    update(field, value.slice(0, start) + token + value.slice(end));
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(start + token.length, start + token.length); });
  }
  function changeTab(next: Tab, focus = false) { setTab(next); if (focus) tabRefs.current[next]?.focus(); }
  function tabKey(event: KeyboardEvent<HTMLButtonElement>, current: Tab) {
    const index = tabs.findIndex(item => item.id === current);
    const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); changeTab(tabs[next].id, true); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!canEdit || problems.length || conflict || operationPending.current) return;
    if (form.status === 'archived' && !window.confirm('Archive this program permanently? It will remain in history and cannot be reactivated.')) return;
    operationPending.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const next = record ? await marketingNotificationApi.update(record.id, { ...form, version: record.version }) : await marketingNotificationApi.create(form);
      setRecord(next); setForm(inputOf(next)); setBaseline(inputOf(next)); onSaved(next); setConflict(false);
      setMessage(`Program saved as ${next.status}. Version ${next.version}.`); setPreviewRefresh(current => current + 1);
      void cache.invalidateQueries({ queryKey: ['notification-programs'] });
      void cache.invalidateQueries({ queryKey: ['notification-audit', next.id] });
    } catch (value) { setError(errorMessage(value)); setConflict(value instanceof ApiError && value.status === 409); }
    finally { operationPending.current = false; setBusy(false); }
  }
  async function generate() {
    if (!generationReady || !record || operationPending.current) return;
    const requestSnapshot = JSON.stringify([record.id, record.version, customerId, currentPreview?.event_id]);
    if (generationRequest.current?.snapshot !== requestSnapshot) generationRequest.current = { snapshot: requestSnapshot, key: crypto.randomUUID() };
    operationPending.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = await marketingNotificationApi.generate(record.id, { customer_id: customerId, version: record.version, idempotency_key: generationRequest.current.key });
      generationRequest.current = null;
      setMessage(result.outcome === 'generated' ? 'Notification record generated. No message was sent.' : result.outcome === 'duplicate' ? 'A record already exists for this generation request. No duplicate was created.' : `Generation suppressed${result.reason ? `: ${label(result.reason)}` : '.'}`);
      setPreviewRefresh(current => current + 1);
      void cache.invalidateQueries({ queryKey: ['notification-records', record.id] });
      void cache.invalidateQueries({ queryKey: ['notification-audit', record.id] });
    } catch (value) { setError(errorMessage(value)); setConflict(value instanceof ApiError && value.status === 409); }
    finally { operationPending.current = false; setBusy(false); }
  }
  function loadCustomer(event: FormEvent) {
    event.preventDefault();
    if (!validCustomerId(customerInput.trim())) { setCustomerError('Enter a valid customer UUID from a customer profile.'); return; }
    setCustomerError(''); setCustomerId(customerInput.trim()); setPreviewRefresh(current => current + 1); setMessage('');
    if (customerId === customerInput.trim()) void customer.refetch();
  }
  async function reload() {
    if (!record || operationPending.current || (dirty && !window.confirm('Discard your unsaved edits and load the latest saved program?'))) return;
    operationPending.current = true; setBusy(true); setError('');
    try {
      const next = await marketingNotificationApi.get(record.id);
      setRecord(next); setForm(inputOf(next)); setBaseline(inputOf(next)); onSaved(next); setConflict(false); setMessage('Latest saved program loaded.'); setPreviewRefresh(current => current + 1);
      void cache.invalidateQueries({ queryKey: ['notification-programs'] });
    } catch (value) { setError(errorMessage(value)); }
    finally { operationPending.current = false; setBusy(false); }
  }
  const triggerLabel = metadata.triggers.find(trigger => trigger.id === form.trigger_kind)?.label;
  const conditions = normalizeNotificationConditions(form.conditions);
  const ruleSummary = notificationProgramSummary(form, metadata);
  return <section className="mn-editor" aria-label="Notification program editor">
    <div className="mn-editor-heading"><div><span className="mn-eyebrow">{record ? 'JOURNEY PROGRAM' : 'NEW JOURNEY PROGRAM'}</span><h2>{record?.name || 'Create a notification program'}</h2><p>{record ? `Last saved ${timestamp(record.updated_at)}` : 'Set the rules once. Preview a personal message for each customer.'}</p></div><span className="mn-status" data-status={record?.status ?? 'draft'}>{record ? label(record.status) : 'Unsaved'}</span></div>
    <div className="mn-editor-nav"><div role="tablist" aria-label="Program workspace">{tabs.map(item => <button type="button" key={item.id} ref={element => { tabRefs.current[item.id] = element; }} role="tab" id={`${fieldId}-${item.id}-tab`} aria-controls={`${fieldId}-${item.id}-panel`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => changeTab(item.id)} onKeyDown={event => tabKey(event, item.id)}>{item.label}</button>)}</div><span className="mn-save-state" data-dirty={dirty}>{dirty ? 'Unsaved changes' : record ? 'All changes saved' : 'Not saved yet'}</span></div>
    {error && <div className="mn-feedback"><Notice error>{error}</Notice>{conflict && <button className="secondary" disabled={busy} onClick={() => void reload()}>Reload saved program</button>}</div>}
    {message && <div className="mn-feedback"><Notice>{message}</Notice></div>}
    <div role="tabpanel" id={`${fieldId}-program-panel`} aria-labelledby={`${fieldId}-program-tab`} hidden={tab !== 'program'} tabIndex={0}>
      {!canWrite && <p className="mn-read-only">You can inspect this program. Editing requires Notifications write access.</p>}
      {record?.status === 'archived' && <p className="mn-read-only">Archived programs are retained for reference and cannot be reactivated. Create a new program to resume this communication.</p>}
      <form className="mn-form mn-guided-form" onSubmit={save}>
        <div className="mn-program-layout"><div className="mn-program-fields">
          <fieldset className="mn-program-identity" disabled={!canEdit || busy}><label className="field">Program name<input required maxLength={120} value={form.name} onChange={event => update('name', event.target.value)} placeholder="e.g. A thoughtful cart reminder"/></label></fieldset>
          <fieldset className="mn-numbered-section" disabled={!canEdit || busy}><legend><span>1</span> When</legend><p className="mn-section-intro">Choose the customer activity that starts this message.</p><label className="field">Journey trigger<select value={form.trigger_kind} onChange={event => update('trigger_kind', event.target.value)}>{metadata.triggers.map(trigger => <option key={trigger.id} value={trigger.id}>{trigger.label}</option>)}</select></label>
            <label className="field mn-delay-field">Delay (minutes)<input type="number" min={0} max={129600} step={1} required value={Number.isNaN(form.delay_minutes) ? '' : form.delay_minutes} onChange={event => update('delay_minutes', event.target.valueAsNumber)}/><small>Wait this long after the activity. Use 0 to make it eligible immediately.</small></label>
            <details className="mn-advanced"><summary>Timing &amp; repeat limits</summary><div className="mn-advanced-content"><div className="mn-field-grid"><label className="field">Event lookback (days)<input type="number" min={1} max={90} step={1} required value={Number.isNaN(form.lookback_days) ? '' : form.lookback_days} onChange={event => update('lookback_days', event.target.valueAsNumber)}/><small>Look for activity within this many days.</small></label><label className="field">Customer cooldown (hours)<input type="number" min={0} max={2160} step={1} required value={Number.isNaN(form.cooldown_hours) ? '' : form.cooldown_hours} onChange={event => update('cooldown_hours', event.target.valueAsNumber)}/><small>Wait between messages from this program.</small></label></div><label className="mn-checkbox"><input type="checkbox" checked={form.suppress_after_purchase} onChange={event => update('suppress_after_purchase', event.target.checked)}/><span>Suppress after a later purchase<small>Skip customers who placed an order after the selected activity.</small></span></label></div></details>
          </fieldset>
          <fieldset className="mn-numbered-section" disabled={!canEdit || busy}><legend><span>2</span> Only if <small>Optional</small></legend><NotificationConditionsEditor value={conditions} fields={metadata.condition_fields ?? []} trigger={form.trigger_kind} disabled={!canEdit || busy} onChange={value => update('conditions', value)}/></fieldset>
          <fieldset className="mn-numbered-section" disabled={!canEdit || busy}><legend><span>3</span> Message</legend><p className="mn-section-intro">Write a helpful message and add personal details.</p><label className="field">Notification title<input ref={element => { contentRefs.current.title_template = element; }} onFocus={() => { focusedContent.current = 'title_template'; }} required maxLength={200} value={form.title_template} onChange={event => update('title_template', event.target.value)} placeholder="A personal, helpful headline"/></label><label className="field">Notification body<textarea ref={element => { contentRefs.current.body_template = element; }} onFocus={() => { focusedContent.current = 'body_template'; }} rows={5} required maxLength={8000} value={form.body_template} onChange={event => update('body_template', event.target.value)} placeholder="Write the message your customer should see…"/><small>{Array.from(form.body_template).length.toLocaleString()} / 8,000 characters</small></label>
            <div className="mn-simple-variables"><span>Add a personal detail</span><div>{metadata.tokens.map(token => <button type="button" title={`{{${token.key}}}`} aria-label={`Insert ${token.label}`} key={token.key} className="mn-token" onMouseDown={event => event.preventDefault()} onClick={() => insertToken(token.key)}>{token.label}<span aria-hidden="true"> +</span></button>)}</div><p>Inserted into the title or message you last selected. Available values depend on the customer and event.</p></div>
          </fieldset>
          <fieldset className="mn-numbered-section mn-review-section" disabled={!canEdit || busy}><legend><span>4</span> Review</legend><div className="mn-rule-summary" aria-label="Program rule summary"><strong>In plain language</strong><p>{ruleSummary}</p><small>{form.suppress_after_purchase ? 'Skip customers who purchased afterwards. ' : ''}{form.cooldown_hours ? `Wait ${form.cooldown_hours} hours between messages. ` : ''}Only activity from the last {form.lookback_days} days is considered.</small></div><label className="field">Program status<select value={form.status} onChange={event => update('status', event.target.value as NotificationProgramInput['status'])}>{statuses.map(value => <option key={value} value={value}>{label(value)}</option>)}</select><small>{form.status === 'active' ? 'Active allows you to generate messages after saving. Publication is a separate step.' : form.status === 'draft' ? 'Keep this as a draft while you prepare the message.' : form.status === 'paused' ? 'Pause new messages while keeping the program and its history.' : 'Archived programs cannot be reactivated.'}</small></label></fieldset>
          <details className="mn-advanced mn-program-settings"><summary>Advanced settings</summary><fieldset className="mn-advanced-content" disabled={!canEdit || busy}><label className="field">Description<textarea rows={2} maxLength={1000} value={form.description} onChange={event => update('description', event.target.value)} placeholder="An internal note for your team"/></label><label className="field">Channel<select value={form.channel} onChange={event => update('channel', event.target.value as NotificationProgramInput['channel'])}>{metadata.channels.map(channel => <option key={channel.id} value={channel.id}>{channel.label}</option>)}</select><small>In-app messages can be published to the storefront inbox. Other channels prepare content only.</small></label>{record && <dl><div><dt>Program ID</dt><dd>{record.id}</dd></div><div><dt>Saved version</dt><dd>{record.version}</dd></div></dl>}</fieldset></details>
        </div>
        <aside className="mn-live-review" aria-label="Live message outline"><div className="mn-live-review-heading"><BellIcon/><strong>Message preview</strong><span>Live</span></div><div className="mn-live-message"><h3 dir="auto">{notificationTemplateOutline(form.title_template, metadata.tokens) || 'Your notification title'}</h3><p dir="auto">{notificationTemplateOutline(form.body_template, metadata.tokens) || 'Your message will appear here as you type.'}</p></div><p className="mn-live-caption">Details in ‹brackets› will be filled from the customer’s activity.</p><button className="secondary" type="button" onClick={() => changeTab('preview', true)}>Test with a customer →</button><div className="mn-live-checklist"><strong>Before customers see this</strong><ol><li>Save your program.</li><li>Check a customer and generate.</li><li>Review and publish to their inbox.</li></ol></div>{form.channel !== 'in_app' && <p className="mn-external-channel">{metadata.channels.find(channel => channel.id === form.channel)?.label || label(form.channel)} content only. This channel is not connected for delivery.</p>}</aside>
        </div>
        {canWrite && dirty && problems.length > 0 && <div className="mn-validation"><strong>Before saving</strong><ul>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></div>}
        <div className="mn-save-bar"><div><strong>{dirty ? 'You have unsaved changes' : record ? 'Your program is saved' : 'Ready when you are'}</strong><p>Saving keeps your work. It does not publish a message.</p></div><div>{canEdit && <button type="submit" disabled={busy || conflict || problems.length > 0 || (!!record && !dirty)}>{busy ? 'Saving…' : 'Save program'}</button>}<button type="button" className="secondary" onClick={() => changeTab('preview', true)}>Review preview →</button></div></div>
      </form>
    </div>
    <div role="tabpanel" id={`${fieldId}-preview-panel`} aria-labelledby={`${fieldId}-preview-tab`} hidden={tab !== 'preview'} tabIndex={0}>
      {!canInspect ? <AccessMessage/> : <div className="mn-preview"><div className="mn-panel-heading"><div><h3>Preview a real customer’s experience</h3><p>Eligibility and message values are evaluated against saved customer and journey data.</p></div><span className="mn-status">{dirty || !record ? 'Unsaved content' : `Saved v${record.version}`}</span></div>
        <div className="mn-customer-search"><label className="field">Search customers<input type="search" placeholder="Search by name, email or mobile…" value={customerSearch} disabled={busy} onChange={event => setCustomerSearch(event.target.value)}/><small>Enter at least two characters to find a customer.</small></label>{appliedCustomerSearch.length >= 2 && <div className="mn-customer-results" aria-label="Matching customers">{customers.isFetching && <p role="status">Searching customers…</p>}{customers.error && <Notice error>{customers.error.message}<button className="secondary" onClick={() => void customers.refetch()}>Retry customer search</button></Notice>}{!customers.isFetching && customerSearch.trim() === appliedCustomerSearch && customers.data?.items.map(item => <button type="button" className="mn-customer-result" key={item.id} disabled={busy} aria-pressed={customerId === item.id} aria-label={`Select customer ${[item.first_name, item.last_name].filter(Boolean).join(' ') || item.email || item.id}`} onClick={() => { setCustomerId(item.id); setCustomerInput(item.id); setCustomerSearch(''); setAppliedCustomerSearch(''); setCustomerError(''); setPreviewRefresh(current => current + 1); setMessage(''); }}><strong>{[item.first_name, item.last_name].filter(Boolean).join(' ') || 'Customer'}</strong><span>{item.email || item.mobile_number || item.id}</span><small>{item.id}</small></button>)}{!customers.isFetching && customers.data?.items.length === 0 && <p>No customers match this search.</p>}{customers.data?.next_cursor && <p>Showing the first 20 matches. Refine your search to find a specific customer.</p>}</div>}</div>
        <details className="mn-customer-manual"><summary>Use a customer ID</summary><form onSubmit={loadCustomer} className="mn-customer-picker"><label className="field">Customer ID<input value={customerInput} onChange={event => { setCustomerInput(event.target.value); setCustomerError(''); setMessage(''); }} placeholder="Customer UUID from a profile" autoComplete="off" spellCheck={false} disabled={busy}/></label><button className="secondary" type="submit" disabled={busy || !customerInput.trim() || customer.isFetching}>{customer.isFetching ? 'Loading…' : 'Load customer'}</button><Link to="/customers/profiles">Browse customers ↗</Link></form></details>
        {customerError && <Notice error>{customerError}</Notice>}{customer.error && <Notice error>{customer.error.message}<button className="secondary" onClick={() => void customer.refetch()}>Retry customer</button></Notice>}
        {customerReady && customer.data && <div className="mn-selected-customer"><span className="mn-customer-avatar" aria-hidden="true">{(customer.data.first_name || customer.data.account.email || 'C').slice(0, 1).toUpperCase()}</span><div><strong>{[customer.data.first_name, customer.data.last_name].filter(Boolean).join(' ') || 'Customer'}</strong><small>{customer.data.account.email || customer.data.account.mobile_number || customerId}</small></div><Link to={`/customers/journey/${customerId}`}>View journey →</Link></div>}
        {!customerReady && !customer.error && <div className="mn-preview-placeholder"><BellIcon/><h3>Personalization starts with a customer</h3><p>Load a customer to check their matching journey event and see the resolved message.</p></div>}
        {customerReady && problems.length > 0 && <div className="mn-validation"><strong>Complete the program to preview</strong><ul>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></div>}
        {previewPending && previewAllowed && <p role="status" className="mn-loading">Evaluating journey activity and resolving variables…</p>}
        {previewError && <Notice error>{previewError}<button className="secondary" onClick={() => setPreviewRefresh(current => current + 1)}>Retry preview</button></Notice>}
        {currentPreview && <div className="mn-preview-grid"><div className="mn-message-stage"><div className="mn-message-channel"><BellIcon/><span>{metadata.channels.find(channel => channel.id === form.channel)?.label || label(form.channel)} preview</span><small>NOT SENT</small></div><article className="mn-message"><h4>{currentPreview.title || 'No resolved title'}</h4><p>{currentPreview.body || 'No resolved content'}</p></article><p className="mn-preview-caption">Preview reflects the current editor content. Generating does not publish to a storefront inbox.</p></div><div className="mn-eligibility"><span className="mn-status" data-status={currentPreview.eligible ? 'active' : 'paused'}>{currentPreview.eligible ? 'Eligible to generate' : 'Generation blocked'}</span><h4>{triggerLabel}</h4><p>{currentPreview.event_id ? 'A matching recorded journey event was found.' : 'No matching event is available.'}</p>{currentPreview.reasons.length > 0 && <ul>{currentPreview.reasons.map(reason => <li key={reason}>{label(reason)}</li>)}</ul>}{currentPreview.missing_tokens.length > 0 && <div className="mn-missing"><strong>Missing variables</strong>{currentPreview.missing_tokens.map(token => <code key={token}>{`{{${token}}}`}</code>)}</div>}<button className="text-button" disabled={previewPending || busy} onClick={() => setPreviewRefresh(current => current + 1)}>Refresh eligibility</button><details><summary>Resolved journey context</summary><dl>{currentPreview.event_id && <div><dt>Event ID</dt><dd>{currentPreview.event_id}</dd></div>}{Object.entries(currentPreview.context).map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{value || 'Unavailable'}</dd></div>)}</dl></details></div></div>}
        {currentPreview && <NotificationConditionResults preview={currentPreview} conditions={conditions} fields={metadata.condition_fields ?? []}/>}
        <div className="mn-generation-bar"><div><strong>Generate a notification record</strong><p>{!canGenerate ? 'Your role does not have Notifications generate access.' : !record || dirty ? 'Save your changes before generating a record.' : record.status !== 'active' ? 'Set this program to Active and save to enable generation.' : 'Eligibility is checked again when you generate. No message will be sent.'}</p></div><button type="button" disabled={!generationReady} onClick={() => void generate()}>{busy ? 'Working…' : 'Generate record'}</button></div>
      </div>}
    </div>
    <div role="tabpanel" id={`${fieldId}-history-panel`} aria-labelledby={`${fieldId}-history-tab`} hidden={tab !== 'history'} tabIndex={0}>
      {!canInspect ? <AccessMessage/> : !record ? <div className="mn-empty"><h3>Save your program first</h3><p>Generated records will appear here after you review a customer and generate.</p></div> : <div className="mn-history"><div className="mn-panel-heading"><div><h3>Generated records</h3><p>Saved content and the program version used at generation. In-app records require a separate publication before customers can see them.</p></div><button className="secondary" disabled={history.isFetching} onClick={() => void history.refetch()}>Refresh records</button></div>{history.isPending && <p role="status">Loading generated records…</p>}{history.error && <Notice error>{history.error.message}</Notice>}{history.data?.records.map(item => <article className="mn-record" key={item.id}><div className="mn-record-heading"><span className="mn-status">Generated record</span><time dateTime={item.created_at}>{timestamp(item.created_at)}</time></div><h4>{item.title}</h4><p>{item.body}</p><div className="mn-record-meta"><span>{metadata.channels.find(channel => channel.id === item.channel)?.label || label(item.channel)} · Program v{item.program_version}</span><Link to={`/customers/journey/${item.customer_id}`}>Customer journey →</Link></div><details><summary>Record details</summary><dl><div><dt>Record ID</dt><dd>{item.id}</dd></div><div><dt>Customer ID</dt><dd>{item.customer_id}</dd></div><div><dt>Journey event</dt><dd>{item.event_id || 'Not available'}</dd></div></dl></details>{item.channel === 'in_app' && canPublish && <button className="secondary np-record-publish" onClick={() => setPublishingRecord(item)}>Publish to customer inbox</button>}</article>)}{history.data && !history.data.records.length && <div className="mn-empty"><BellIcon/><h3>No notifications generated yet</h3><p>Use Preview &amp; generate to review a customer and create the first record.</p><button className="secondary" onClick={() => changeTab('preview', true)}>Open preview</button></div>}{history.data && <Pagination name="records" offset={historyOffset} count={history.data.records.length} total={history.data.total} busy={history.isFetching} onChange={setHistoryOffset}/>}</div>}
    </div>
    <div role="tabpanel" id={`${fieldId}-audit-panel`} aria-labelledby={`${fieldId}-audit-tab`} hidden={tab !== 'audit'} tabIndex={0}>
      {!record ? <div className="mn-empty"><h3>A clear history of every change</h3><p>Save the program to start its audit trail.</p></div> : <div className="mn-audit"><div className="mn-panel-heading"><div><h3>Recent audit activity</h3><p>The latest 25 recorded actions with administrator, time, and program version.</p></div><button className="secondary" disabled={audit.isFetching} onClick={() => void audit.refetch()}>Refresh audit</button></div>{audit.isPending && <p role="status">Loading audit trail…</p>}{audit.error && <Notice error>{audit.error.message}</Notice>}{audit.data?.events.length === 0 && <div className="mn-empty">No audit events are available.</div>}<ol className="mn-audit-list">{audit.data?.events.map(event => <li key={event.id}><span className="mn-audit-marker" aria-hidden="true"/><div><strong>{label(event.action)}</strong><span>Version {event.version} · <time dateTime={event.created_at}>{timestamp(event.created_at)}</time></span><small>Administrator: {event.actor_id || 'System or deleted administrator'}</small></div></li>)}</ol></div>}
    </div>
    {publishingRecord && <PublishGeneratedNotification record={publishingRecord} onDirtyChange={setPublicationDirty} onBusyChange={setPublicationBusy} onClose={() => setPublishingRecord(null)}/>}
  </section>;
}

function programProblems(form: NotificationProgramInput, metadata: NotificationMetadata): string[] {
  const problems: string[] = [];
  if (!form.name.trim()) problems.push('Enter a program name.');
  if (!form.title_template.trim()) problems.push('Write a notification title.');
  if (!form.body_template.trim()) problems.push('Write notification content.');
  if (!metadata.triggers.some(trigger => trigger.id === form.trigger_kind)) problems.push('Choose a supported journey trigger.');
  if (!metadata.channels.some(channel => channel.id === form.channel)) problems.push('Choose a supported channel.');
  for (const [name, value, minimum, maximum] of [['Delay', form.delay_minutes, 0, 129600], ['Event lookback', form.lookback_days, 1, 90], ['Customer cooldown', form.cooldown_hours, 0, 2160]] as const) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) problems.push(`${name} must be a whole number between ${minimum} and ${maximum}.`);
  }
  if (form.delay_minutes >= form.lookback_days * 1440) problems.push('Delay must be shorter than the event lookback window.');
  for (const [name, value, maximum] of [['Program name', form.name, 120], ['Description', form.description, 1000], ['Notification title', form.title_template, 200], ['Notification body', form.body_template, 8000]] as const) {
    if (Array.from(value).length > maximum) problems.push(`${name} cannot exceed ${maximum} characters.`);
  }
  for (const [name, value] of [['Title', form.title_template], ['Body', form.body_template]] as const) {
    const tokens = [...value.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)];
    if (tokens.length > 40) problems.push(`${name} cannot contain more than 40 variables.`);
    const unknown = [...new Set(tokens.map(match => match[1]).filter(token => !metadata.tokens.some(allowed => allowed.key === token)))];
    if (unknown.length) problems.push(`${name} contains unsupported variables: ${unknown.join(', ')}.`);
  }
  problems.push(...notificationConditionProblems(normalizeNotificationConditions(form.conditions), metadata.condition_fields ?? [], form.trigger_kind));
  return problems;
}
