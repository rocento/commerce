import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, catalogApi, deliveryApi, notificationPublicationApi, notificationCampaignApi, type NotificationCampaign, type GeneratedNotification, type NotificationPublication } from '@commerce/api-client';
import { Notice } from '@commerce/ui';
import './notification-publications.css';
import { NotificationCampaignComposer } from './notification-campaigns';
import { defaultForm, validation, localTime, DAY, type Audience, type PublicationForm } from './notification-publication-model';

type EditorState = { onDirtyChange: (value: boolean) => void; onBusyChange: (value: boolean) => void };
const audienceNames = { all: 'Everyone', guests: 'Guests', customers: 'Signed-in customers', customer: 'One customer' };
const PAGE_SIZE = 10;
const errorMessage = (value: unknown) => value instanceof Error ? value.message : 'The publication could not be completed. Please try again.';
const formatTime = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function visibility(publication: NotificationPublication, now: number) {
  if (publication.withdrawn_at) return 'Withdrawn';
  if (new Date(publication.expires_at).getTime() <= now) return 'Expired';
  return new Date(publication.published_at).getTime() > now ? 'Scheduled' : 'Live';
}

export function NotificationPublicationManager({ canPublish, canWrite, canReadCustomers, canReadOrders, onDirtyChange, onBusyChange }: EditorState & { canPublish: boolean; canWrite: boolean; canReadCustomers: boolean; canReadOrders: boolean }) {
  const cache = useQueryClient();
  const [offset, setOffset] = useState(0), [composer, setComposer] = useState<NotificationCampaign | 'new' | null>(null);
  const [draftOffset, setDraftOffset] = useState(0);
  const [draftDirty, setDraftDirty] = useState(false), [draftBusy, setDraftBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState<NotificationPublication | null>(null), [withdrawBusy, setWithdrawBusy] = useState(false);
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [conflict, setConflict] = useState(false), [now, setNow] = useState(Date.now());
  const [search, setSearch] = useState(''), [statusFilter, setStatusFilter] = useState('all');
  const [deleting, setDeleting] = useState(false);
  const pending = useRef(false);
  const drafts = useQuery({ queryKey: ['notification-campaigns', draftOffset], queryFn: ({ signal }) => notificationCampaignApi.list({ status: 'draft', offset: draftOffset, limit: PAGE_SIZE }, signal), retry: false });
  const list = useQuery({ queryKey: ['notification-publications', offset, search, statusFilter], queryFn: ({ signal }) => notificationPublicationApi.list({ offset, limit: PAGE_SIZE, search, status: statusFilter }, signal), retry: false });
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30000); return () => window.clearInterval(timer); }, []);
  useEffect(() => { onDirtyChange(draftDirty); return () => onDirtyChange(false); }, [draftDirty, onDirtyChange]);
  useEffect(() => { onBusyChange(draftBusy || withdrawBusy); return () => onBusyChange(false); }, [draftBusy, withdrawBusy, onBusyChange]);
  useEffect(() => { if (list.data && offset > 0 && offset >= list.data.total) setOffset(Math.max(0, Math.ceil(list.data.total / PAGE_SIZE) - 1) * PAGE_SIZE); }, [list.data, offset]);
  function closeComposer() {
    if (draftBusy || (draftDirty && !window.confirm('Discard unsaved campaign changes?'))) return;
    setComposer(null); setDraftDirty(false);
  }
  async function withdraw() {
    if (!withdrawing || !canPublish || pending.current || conflict) return;
    pending.current = true; setWithdrawBusy(true); setError(''); setMessage('');
    try {
      await (deleting ? notificationPublicationApi.delete : notificationPublicationApi.withdraw)(withdrawing.id, { version: withdrawing.version });
      setMessage(deleting ? 'Notification deleted from publication history and storefront inboxes.' : 'Publication withdrawn. It is no longer visible in storefront inboxes.'); setWithdrawing(null);
      await cache.invalidateQueries({ queryKey: ['notification-publications'] });
    } catch (value) { setError(errorMessage(value)); setConflict(value instanceof ApiError && value.status === 409); }
    finally { pending.current = false; setWithdrawBusy(false); }
  }
  return <section className="np-manager" aria-label="Notification campaigns">
    <div className="np-heading"><div><span className="mn-eyebrow">AUDIENCE CAMPAIGNS</span><h2>Campaigns</h2><p>Combine segments, customer activity, conditions and timing in one campaign.</p></div>{canWrite ? <button disabled={!!composer || withdrawBusy} onClick={() => { setComposer('new'); setMessage(''); }}>New campaign</button> : <span className="mn-access-label">{canPublish ? 'Review & activate access' : 'View only'}</span>}</div>
    <div className="np-guidance"><strong>Draft → Review → Activate</strong><span>Start with everyone, guests or signed-in customers. Add the rules that matter, save a draft, then review and activate.</span><span className="np-channel-pill">Storefront inbox</span></div>
    {composer && <NotificationCampaignComposer key={composer === 'new' ? 'new' : composer.id} campaign={composer === 'new' ? undefined : composer} canWrite={canWrite} canPublish={canPublish} canReadCustomers={canReadCustomers} canReadOrders={canReadOrders} onDirtyChange={setDraftDirty} onBusyChange={setDraftBusy} onClose={closeComposer} onSaved={() => { void cache.invalidateQueries({ queryKey: ['notification-campaigns'] }); }} onPublished={publication => { setComposer(null); setDraftDirty(false); setNow(Date.now()); setMessage(`${new Date(publication.published_at).getTime() > Date.now() ? 'Campaign scheduled' : 'Campaign activated'} for ${audienceNames[publication.audience].toLowerCase()}.`); void cache.invalidateQueries({ queryKey: ['notification-publications'] }); void cache.invalidateQueries({ queryKey: ['notification-campaigns'] }); }}/>} 
    <div className="np-list-heading"><div><h3>Draft campaigns <span className="np-count">{drafts.data?.total ?? '—'}</span></h3><p>Saved for your team. Drafts do not deliver messages.</p></div><button className="text-button" disabled={drafts.isFetching} onClick={() => void drafts.refetch()}>Refresh drafts</button></div>
    {drafts.isPending && <p role="status">Loading drafts…</p>}{drafts.error && <Notice error>{drafts.error.message}<button className="secondary" onClick={() => void drafts.refetch()}>Retry drafts</button></Notice>}
    <div className="np-draft-list">{drafts.data?.items.map(draft => <article className="np-draft-card" key={draft.id}><div><span className="np-status" data-state="draft">Draft</span><h4>{draft.name}</h4><p>{audienceNames[draft.announcement.audience]}{draft.announcement.audience_rules?.trigger_kind ? ` · ${draft.announcement.audience_rules.trigger_kind.replaceAll('_', ' ').replaceAll('.', ' ')}` : ' · Audience campaign'}</p><small>Updated {formatTime(draft.updated_at)}</small></div><button className="secondary" disabled={draftBusy || withdrawBusy} onClick={() => { if (draftDirty && !window.confirm('Discard unsaved campaign changes?')) return; setComposer(draft); setDraftDirty(false); setMessage(''); }}>{canWrite ? 'Edit draft' : 'Review draft'}</button></article>)}</div>
    {drafts.data?.total === 0 && !composer && <div className="np-draft-empty">No draft campaigns. Start a campaign to define your message and audience.</div>}
    {drafts.data && drafts.data.total > PAGE_SIZE && <nav className="np-pagination" aria-label="Draft campaign pages"><span>{draftOffset + 1}–{draftOffset + drafts.data.items.length} of {drafts.data.total}</span><div><button className="secondary" disabled={draftOffset === 0 || drafts.isFetching} onClick={() => setDraftOffset(Math.max(0, draftOffset - PAGE_SIZE))}>Previous drafts</button><button className="secondary" disabled={draftOffset + drafts.data.items.length >= drafts.data.total || drafts.isFetching} onClick={() => setDraftOffset(draftOffset + PAGE_SIZE)}>Next drafts</button></div></nav>}
    {message && <Notice>{message}</Notice>}
    {error && <Notice error>{error}{conflict && <button className="secondary" onClick={() => { setWithdrawing(null); setConflict(false); setError(''); void list.refetch(); }}>Reload publications</button>}</Notice>}
    <div className="np-list-heading"><div><h3>Active campaigns & publication history</h3><p>Search your notifications or filter by status. Newest publications appear first.</p></div><button className="secondary" disabled={list.isFetching || withdrawBusy} onClick={() => void list.refetch()}>Refresh publications</button></div>
    <div className="np-filters"><label className="field">Search notifications<input type="search" maxLength={200} value={search} placeholder="Search title or message" disabled={withdrawBusy} onChange={event => { setSearch(event.target.value); setOffset(0); }}/></label><label className="field">Status<select aria-label="Status" value={statusFilter} disabled={withdrawBusy} onChange={event => { setStatusFilter(event.target.value); setOffset(0); }}><option value="all">All statuses</option>{['Live', 'Scheduled', 'Expired', 'Withdrawn'].map(status => <option key={status} value={status.toLowerCase()}>{status}</option>)}</select></label></div>
    {list.isPending && <p role="status">Loading publications…</p>}
    {list.error && <Notice error>{list.error.message}<button className="secondary" onClick={() => void list.refetch()}>Retry publications</button></Notice>}
    {list.data?.publications.length === 0 && <div className="np-empty"><h3>{search || statusFilter !== 'all' ? 'No matching notifications' : 'No messages published yet'}</h3><p>{search || statusFilter !== 'all' ? 'Try another search or status.' : 'Activate a campaign to start reaching your audience.'}</p></div>}
    <div className="np-publications">{list.data?.publications.map(publication => {
      const status = visibility(publication, now);
      return <article className="np-publication" key={publication.id} aria-label={`Publication: ${publication.title}`}>
        <div className="np-summary"><div className="np-publication-top"><span className="np-status" data-state={status.toLowerCase()}>{status}</span><span>{audienceNames[publication.audience]}{publication.area_ids?.length ? ` · ${publication.area_ids.length} delivery area(s)` : ' · All locations'}</span></div>
        <h4>{publication.title}</h4>{publication.audience_rules ? <p className="np-hint">{publication.audience_rules.trigger_kind?.replaceAll('_', ' ').replaceAll('.', ' ') || 'Audience campaign'} · {publication.audience_rules.segment_ids.length} segments · {publication.audience_rules.conditions.rules.length} conditions · {publication.audience_rules.max_deliveries === 1 ? 'Once per recipient' : `Up to ${publication.audience_rules.max_deliveries} deliveries`}</p> : publication.trigger_product_id && <p className="np-hint">Product visit automation · Once per visitor</p>}<p className="np-body-preview">{publication.body}</p>
        {publication.cta_path && <span className="np-action-label">{publication.cta_label} <code>{publication.cta_path}</code></span>}
        </div><dl className="np-dates"><div><dt>Visible from</dt><dd>{formatTime(publication.published_at)}</dd></div><div><dt>Expires</dt><dd>{formatTime(publication.expires_at)}</dd></div></dl><details className="np-reference"><summary>View full message & details</summary><p className="np-full-message" dir="auto">{publication.body}</p><dl><div><dt>Version</dt><dd>{publication.version}</dd></div>{publication.customer_id && <div><dt>Customer</dt><dd>{publication.customer_id}</dd></div>}{publication.source_record_id && <div><dt>Generated record</dt><dd>{publication.source_record_id}</dd></div>}<div><dt>Publication ID</dt><dd>{publication.id}</dd></div></dl></details>
        {canPublish && <div className="np-withdraw">{withdrawing?.id === publication.id ? <><p>{deleting ? 'Delete this notification from history and customer inboxes? This cannot be undone.' : <>Withdraw this message from {publication.audience === 'customer' ? 'this customer’s inbox' : `${audienceNames[publication.audience].toLowerCase()} inboxes`}?</>}</p><button className="secondary" disabled={withdrawBusy || conflict} onClick={() => void withdraw()}>{withdrawBusy ? 'Saving…' : deleting ? 'Confirm deletion' : 'Confirm withdrawal'}</button><button className="text-button" disabled={withdrawBusy} onClick={() => { setWithdrawing(null); setConflict(false); setError(''); }}>Keep publication</button></> : <>{['Live', 'Scheduled'].includes(status) && <button className="secondary" disabled={withdrawBusy || draftBusy} onClick={() => { setDeleting(false); setWithdrawing(publication); setConflict(false); setError(''); }}>Withdraw publication</button>}<button className="secondary np-delete" disabled={withdrawBusy || draftBusy} onClick={() => { setDeleting(true); setWithdrawing(publication); setConflict(false); setError(''); }}>Delete notification</button></>}</div>}
      </article>;
    })}</div>
    {list.data && <nav className="np-pagination" aria-label="Publication pages"><span>{list.data.total ? `${offset + 1}–${offset + list.data.publications.length} of ${list.data.total}` : '0 publications'}</span><div><button className="secondary" disabled={offset === 0 || list.isFetching || withdrawBusy} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>Previous publications</button><button className="secondary" disabled={offset + list.data.publications.length >= list.data.total || list.isFetching || withdrawBusy} onClick={() => setOffset(offset + PAGE_SIZE)}>Next publications</button></div></nav>}
  </section>;
}

export function PublishGeneratedNotification({ record, onClose, onDirtyChange, onBusyChange }: EditorState & { record: GeneratedNotification; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [publication, setPublication] = useState<NotificationPublication | null>(null);
  const cache = useQueryClient();
  const previouslyFocused = useRef<Element | null>(null);
  useEffect(() => { previouslyFocused.current = document.activeElement; dialog.current?.showModal(); return () => { if (previouslyFocused.current instanceof HTMLElement) previouslyFocused.current.focus(); }; }, []);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  function close() { if (!busy && (!dirty || window.confirm('Discard this unpublished inbox message?'))) onClose(); }
  return <dialog ref={dialog} className="np-dialog" aria-labelledby="np-targeted-heading" onCancel={event => { event.preventDefault(); close(); }}>
    <div className="np-dialog-heading"><div><span className="mn-eyebrow">REVIEW CUSTOMER PUBLICATION</span><h2 id="np-targeted-heading">Publish to customer inbox</h2></div><button className="secondary" aria-label="Close publication review" disabled={busy} onClick={close}>×</button></div>
    {publication ? <div className="np-published"><Notice>{new Date(publication.published_at).getTime() > Date.now() ? 'Customer message scheduled.' : 'Customer message published.'} Only the customer attached to this record can see it.</Notice><p>Content is fixed to the saved generated record. Manage visibility in campaign history.</p><button onClick={close}>Done</button></div> : <PublicationComposer record={record} onDirtyChange={setDirty} onBusyChange={setBusy} onClose={close} onPublished={value => { setPublication(value); setDirty(false); void cache.invalidateQueries({ queryKey: ['notification-publications'] }); }}/>}
  </dialog>;
}

function PublicationComposer({ record, onClose, onPublished, onDirtyChange, onBusyChange }: EditorState & { record?: GeneratedNotification; onClose: () => void; onPublished: (value: NotificationPublication) => void }) {
  const areas = useQuery({ queryKey: ['notification-area-choices'], queryFn: deliveryApi.choices, enabled: !record });
  const [initial] = useState(() => defaultForm(record));
  const [form, setForm] = useState(initial), [reviewed, setReviewed] = useState(false), [busy, setBusy] = useState(false);
  const [step, setStep] = useState<1 | 2>(1), [areaSearch, setAreaSearch] = useState('');
  const [productSearch, setProductSearch] = useState('');
  const [productQuery, setProductQuery] = useState('');
  useEffect(() => { const timer = window.setTimeout(() => setProductQuery(productSearch.trim()), 300); return () => window.clearTimeout(timer); }, [productSearch]);
  const productChoices = useQuery({ queryKey: ['notification-product-choices', productQuery], queryFn: ({ signal }) => catalogApi.search({ q: productQuery }, signal), enabled: !record && form.productTargeted && !!productQuery });
  const [duration, setDuration] = useState<number | null>(7);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [step, reviewed]);
  const [error, setError] = useState(''), [uncertain, setUncertain] = useState(false), [attempted, setAttempted] = useState(false);
  const request = useRef<{ snapshot: string; key: string } | null>(null), pending = useRef(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial) || reviewed || uncertain;
  const problems = validation(form, !!record);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  function update<Key extends keyof PublicationForm>(key: Key, value: PublicationForm[Key]) { setForm(current => ({ ...current, [key]: value })); setReviewed(false); setError(''); }
  function review(event: FormEvent) {
    event.preventDefault(); setAttempted(true);
    const errors = step === 1 ? validation({ ...form, productTargeted: false, areaTargeted: false, areaIds: [], startsAt: '', expiresAt: localTime(new Date(Date.now() + DAY)) }, !!record) : problems;
    if (errors.length) { setError(step === 1 ? errors.join(' ') : ''); return; }
    setError(''); setAttempted(false);
    if (step === 1) setStep(2); else setReviewed(true);
  }
  function setStart(value: string) {
    const start = value ? new Date(value).getTime() : Date.now();
    setForm(current => ({ ...current, startsAt: value, ...(duration && Number.isFinite(start) ? { expiresAt: localTime(new Date(start + duration * DAY)) } : {}) }));
    setReviewed(false); setError('');
  }
  const matchingAreas = (areas.data ?? []).filter(area => area.name.toLocaleLowerCase().includes(areaSearch.toLocaleLowerCase()));
  const selectedAreaNames = form.areaIds.map(id => areas.data?.find(area => area.id === id)?.name ?? 'Unavailable area');
  const areasReady = !form.areaTargeted || (!!areas.data && !areas.isError && form.areaIds.every(id => areas.data.some(area => area.id === id)));
  const previewCard = <article className="np-inbox-preview" aria-label="Storefront notification preview"><span>LIVE INBOX PREVIEW</span><h3 dir="auto">{form.title || 'Your notification title'}</h3><p dir="auto">{form.body || 'Your message appears here as you write.'}</p>{form.ctaLabel && <span className="np-preview-cta" dir="auto">{form.ctaLabel}</span>}<small>Shown inside the store’s notification bell.</small></article>;
  async function publish() {
    if (!reviewed || pending.current || (!uncertain && (problems.length || !areasReady))) return;
    const payload = { cta_label: form.ctaLabel.trim() || null, cta_path: form.ctaPath.trim() || null, starts_at: form.startsAt ? new Date(form.startsAt).toISOString() : null, expires_at: new Date(form.expiresAt).toISOString() };
    const snapshot = JSON.stringify([record?.id, form.title, form.body, form.audience, form.areaTargeted, form.areaIds, form.productTargeted, form.productId, payload]);
    if (request.current?.snapshot !== snapshot) request.current = { snapshot, key: crypto.randomUUID() };
    pending.current = true; setBusy(true); setError('');
    try {
      const input = { ...payload, idempotency_key: request.current.key };
      const result = record ? await notificationPublicationApi.publishRecord(record.id, input) : await notificationPublicationApi.publishAnnouncement({ ...input, title: form.title, body: form.body, audience: form.audience, area_ids: form.areaTargeted ? form.areaIds : [], trigger_product_id: form.productTargeted ? form.productId : null });
      request.current = null; setUncertain(false); onDirtyChange(false); onPublished(result);
    } catch (value) {
      const ambiguous = !(value instanceof ApiError) || value.status >= 500;
      setError(errorMessage(value)); setUncertain(ambiguous);
      if (!ambiguous) request.current = null;
    } finally { pending.current = false; setBusy(false); }
  }
  return <section className="np-composer" aria-label={record ? 'Customer publication review' : 'Announcement composer'}>
    <div className="np-composer-heading"><div><span className="mn-eyebrow">STOREFRONT NOTIFICATION</span><h3 ref={heading} tabIndex={-1}>{reviewed ? 'Review & publish' : step === 1 ? 'Write your message' : 'Choose your audience & timing'}</h3></div><button className="text-button" disabled={busy || uncertain} onClick={onClose}>Cancel {record ? 'publication' : 'announcement'}</button></div>
    <ol className="np-progress" aria-label="Publishing progress">{['Message', 'Audience & timing', 'Review & publish'].map((name, index) => <li key={name} aria-current={(reviewed ? 3 : step) === index + 1 ? 'step' : undefined}><b>{index + 1}</b>{name}</li>)}</ol>
    {error && <Notice error>{error}</Notice>}
    {uncertain && <Notice error>Publication could not be confirmed. Retry this exact request to confirm its outcome before editing or starting another message.</Notice>}
    <div className="np-compose-layout"><div>
    {!reviewed ? <form onSubmit={review}>
      {step === 1 ? <fieldset disabled={busy}><legend>Message content</legend>
        {record ? <div className="np-source"><span className="np-source-tag">SAVED CUSTOMER MESSAGE</span><h3 dir="auto">{record.title}</h3><p dir="auto">{record.body}</p><small>Content is fixed to this generated record. It will be visible only to its customer.</small></div> : <>
          <label className="field">Announcement title<input required autoFocus dir="auto" aria-label="Announcement title" value={form.title} maxLength={200} onChange={event => update('title', event.target.value)} placeholder="A clear update for your customers"/><small>{[...form.title].length}/200 characters</small></label>
          <label className="field">Announcement message<textarea required dir="auto" aria-label="Announcement message" rows={5} maxLength={8000} value={form.body} onChange={event => update('body', event.target.value)} placeholder="What would you like your customers to know?"/><small>{[...form.body].length.toLocaleString()}/8,000 characters · English and Arabic supported. Plain text only.</small></label>
        </>}
        <details className="np-optional"><summary>Add a button (optional)</summary><div className="np-destination-options" role="group" aria-label="Quick button destinations">{[['Shop products', '/search'], ['View cart', '/cart'], ['Contact us', '/support']].map(([name, path]) => <button className="secondary" type="button" key={path} onClick={() => { update('ctaLabel', name); update('ctaPath', path); }}>{name}</button>)}<button type="button" className="text-button" onClick={() => { update('ctaLabel', ''); update('ctaPath', ''); }}>Remove button</button></div><div className="np-fields"><label className="field">Action label<input aria-label="Action label" value={form.ctaLabel} maxLength={80} onChange={event => update('ctaLabel', event.target.value)}/></label><label className="field">Storefront path<input aria-label="Storefront path" value={form.ctaPath} maxLength={300} onChange={event => update('ctaPath', event.target.value)} placeholder="/search"/></label></div><p className="np-hint">Use a page in your store, such as /search or /products/product-name.</p></details>
      </fieldset> : <>
      <fieldset disabled={busy}><legend>Who should see this?</legend>
        {record ? <div className="np-source"><strong>Only this customer</strong><p>{record.customer_id}</p></div> : <>
          <label className="field">Announcement audience<select aria-label="Announcement audience" value={form.audience} onChange={event => update('audience', event.target.value as Audience)}><option value="all">Everyone — guests and signed-in customers</option><option value="guests">Guests — signed-out visitors only</option><option value="customers">Signed-in customers only</option></select></label>
          <label className="field">Delivery trigger<select aria-label="Delivery trigger" value={form.productTargeted ? 'product' : 'visit'} onChange={event => update('productTargeted', event.target.value === 'product')}><option value="visit">Any store visit</option><option value="product">After visiting a specific product</option></select></label>
          {form.productTargeted && <div className="np-product-picker"><p>Deliver once per guest browser or customer account after they open this product. Repeat visits do not send duplicates.</p><label className="field">Find a product<input type="search" aria-label="Find a product" value={productSearch} onChange={event => setProductSearch(event.target.value)} placeholder="Search by product name"/></label>
            {form.productId && <p><strong>Selected: {form.productName}</strong></p>}
            {productChoices.isFetching ? <p role="status">Searching products…</p> : productChoices.isError ? <Notice error>Could not search products. <button type="button" onClick={() => void productChoices.refetch()}>Retry search</button></Notice> : productChoices.data && <div className="np-area-list" role="group" aria-label="Choose trigger product">{productChoices.data.hits.map(product => <label key={product.id}><input type="radio" name="trigger-product" checked={form.productId === product.id} onChange={() => { update('productId', product.id); update('productName', product.name); }}/><span>{product.name} · {product.sku}</span></label>)}{!productChoices.data.hits.length && <p>No matching products.</p>}</div>}
          </div>}
          <label className="field">Location targeting<select aria-label="Location targeting" value={form.areaTargeted ? 'selected' : 'all'} onChange={event => update('areaTargeted', event.target.value === 'selected')}><option value="all">All locations</option><option value="selected">Selected delivery areas</option></select></label>
          {form.areaTargeted && <div className="np-area-picker"><p>Customers must select a matching delivery location to see this notification.</p><label className="field">Search delivery areas<input type="search" value={areaSearch} onChange={event => setAreaSearch(event.target.value)} placeholder="Search by area name"/></label><strong>{form.areaIds.length} selected</strong>
          {areas.isPending ? <p role="status">Loading delivery areas…</p> : areas.isError ? <Notice error>Could not load delivery areas. <button type="button" onClick={() => void areas.refetch()}>Retry</button></Notice> : !areas.data?.length ? <p>No active delivery areas. Add an area in delivery settings first.</p> : <><div className="np-area-list" role="group" aria-label="Choose delivery areas">{matchingAreas.map(area => <label key={area.id}><input type="checkbox" checked={form.areaIds.includes(area.id)} onChange={event => update('areaIds', event.target.checked ? [...form.areaIds, area.id] : form.areaIds.filter(id => id !== area.id))}/><span>{area.name}</span></label>)}{!matchingAreas.length && <p>No matching areas. Try another name.</p>}</div><button type="button" className="text-button" onClick={() => update('areaIds', [])}>Clear selected areas</button>{selectedAreaNames.length > 0 && <p className="np-hint">Selected: {selectedAreaNames.join(', ')}</p>}</>}</div>}
        </>}
      </fieldset>
      <fieldset disabled={busy} className="np-visibility"><legend>When should it appear?</legend><label className="field">Publish time<select aria-label="Publish time" value={form.startsAt ? 'later' : 'now'} onChange={event => setStart(event.target.value === 'now' ? '' : localTime(new Date(Date.now() + DAY)))}><option value="now">Immediately after publishing</option><option value="later">Schedule for later</option></select></label>{form.startsAt && <label className="field">Start time<input required aria-label="Publication start time" type="datetime-local" value={form.startsAt} onInput={event => setStart(event.currentTarget.value)}/></label>}
        <p className="np-hint">How long should it stay visible?</p><div className="np-duration-options" role="group" aria-label="Notification duration">{[1, 7, 30].map(days => <button type="button" className="secondary" aria-pressed={duration === days} key={days} onClick={() => { setDuration(days); update('expiresAt', localTime(new Date((form.startsAt && Number.isFinite(new Date(form.startsAt).getTime()) ? new Date(form.startsAt).getTime() : Date.now()) + days * DAY))); }}>{days} {days === 1 ? 'day' : 'days'}</button>)}</div>
        <label className="field">Expiry time<input required aria-label="Publication expiry time" type="datetime-local" value={form.expiresAt} onInput={event => { setDuration(null); update('expiresAt', event.currentTarget.value); }}/></label><p className="np-hint">Times use {timeZone}. Maximum visibility: 90 days. You can withdraw a published notification.</p>
      </fieldset></>}
      {attempted && step === 2 && problems.length > 0 && <div className="np-validation" role="alert"><strong>Before reviewing</strong><ul>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></div>}
      <div className="np-composer-actions">{step === 2 ? <button type="button" className="secondary" onClick={() => { setStep(1); setError(''); setAttempted(false); }}>Back to message</button> : <p>Nothing is published until you confirm the review.</p>}<button type="submit" disabled={busy || (step === 2 && !areasReady)}>{step === 1 ? 'Continue to audience & timing' : record ? 'Review customer publication' : 'Review announcement'}</button></div>
    </form> : <div className="np-review">
      <div className="np-review-target"><strong>{record ? 'Only this customer' : audienceNames[form.audience]}</strong>{!record && <span>{form.areaTargeted ? `Delivery areas: ${selectedAreaNames.join(', ')}` : 'All locations'}</span>}{record && <code>{record.customer_id}</code>}{!record && form.productTargeted && <span>After visiting {form.productName} · Once per visitor</span>}<span>{form.startsAt ? `Visible from ${formatTime(new Date(form.startsAt).toISOString())}` : form.productTargeted ? 'Starts accepting product visits immediately' : 'Visible immediately after publication'}</span><span>Expires {formatTime(new Date(form.expiresAt).toISOString())} · {timeZone}</span>{form.ctaPath && <span>Button opens: {form.ctaPath}</span>}</div>
      <p className="np-review-warning">{record ? 'Publishing makes this saved message visible only to its customer in the native storefront inbox.' : form.productTargeted ? `Publishing delivers this message to ${audienceNames[form.audience].toLowerCase()} after they visit ${form.productName}.` : `Publishing makes this message visible to ${audienceNames[form.audience].toLowerCase()} in the native storefront inbox.`} {form.productTargeted ? 'Eligible product visitors receive an alert and a saved inbox message.' : 'It appears under the notification bell when they visit the store.'} Device push, email, SMS and WhatsApp are not sent.</p>
      {!uncertain && problems.length > 0 && <div className="np-validation" role="alert"><ul>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></div>}

    </div>}
    </div><aside className="np-preview-panel">{previewCard}<p className="np-hint">Preview only · This does not send a notification.</p></aside></div>
    {reviewed && <div className="np-composer-actions"><button className="secondary" disabled={busy || uncertain} onClick={() => { setReviewed(false); setStep(1); setError(''); }}>Back to edit</button><button disabled={busy || (!uncertain && (problems.length > 0 || !areasReady))} onClick={() => void publish()}>{busy ? 'Publishing…' : uncertain ? 'Retry publication' : record ? 'Publish to this customer' : form.startsAt ? 'Schedule announcement' : 'Publish announcement'}</button></div>}
  </section>;
}
