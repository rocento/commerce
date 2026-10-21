import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, emailTemplatesApi, type EmailTemplate, type EmailTemplateContent, type EmailTemplatePreview, type EmailTemplateVersion } from '@commerce/api-client';
import { Field, Notice } from '@commerce/ui';
import { PageHeader } from './page-header';
import { ReasonField } from './reason-field';
import { useUnsavedChanges } from './unsaved-changes';
import { emailContentProblems, insertTemplateVariable, matchesEmailTemplate, sameEmailContent, templateStatus } from './email-template-model';
import './email-templates.css';

const reasons = ['Brand voice update', 'Improve customer instructions', 'Update order communication', 'Correct email content', 'Restore a previous version'];
const labels = { account: 'Account & security', orders: 'Orders & fulfillment' };
const workspaceTabs = [{ id: 'content', label: 'Content' }, { id: 'preview', label: 'Preview' }, { id: 'history', label: 'Version history' }] as const;
type WorkspaceTab = typeof workspaceTabs[number]['id'];
const dateLabel = (value: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : 'Built-in template';

function MailIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m4 7 8 6 8-6"/></svg>;
}

export function EmailTemplates({ canWrite, canPublish }: { canWrite: boolean; canPublish: boolean }) {
  const library = useQuery({ queryKey: ['email-templates'], queryFn: emailTemplatesApi.list });
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState(''), [category, setCategory] = useState(''), [status, setStatus] = useState('');
  const [locked, setLocked] = useState(false), [dirty, setDirty] = useState(false);
  const key = selected || library.data?.items[0]?.key || '';
  const detail = useQuery({ queryKey: ['email-template', key], queryFn: () => emailTemplatesApi.get(key), enabled: !!key, staleTime: Infinity });
  const items = library.data?.items ?? [];
  const visible = items.filter(template => matchesEmailTemplate(template, search, category, status));
  function select(next: string) {
    if (next === key || locked) return;
    if (dirty && !window.confirm('Discard unsaved email changes and open another template?')) return;
    setDirty(false); setSelected(next);
  }
  return <main className="email-templates-page">
    <PageHeader title="Email templates" description="Thoughtful communication at every step of the customer journey." actions={<span className="email-access-label">{canWrite && canPublish ? 'Full access' : canWrite ? 'Draft editor' : canPublish ? 'Publisher access' : 'View only'}</span>} />
    <section className="email-overview" aria-label="Email template overview">
      <div className="email-overview-intro"><span className="email-overview-icon"><MailIcon/></span><div><strong>Make every message feel like your brand</strong><p>Prepare a draft, review the preview, then publish when it is ready.</p></div></div>
      <div><strong>{library.data ? items.length : '—'}</strong><span>Templates</span></div>
      <div><strong>{library.data ? items.filter(item => item.has_unpublished_changes).length : '—'}</strong><span>Awaiting publication</span></div>
    </section>
    {library.isPending && <div className="email-empty" role="status">Loading your email templates…</div>}
    {library.error && <Notice error>{library.error.message}<button className="secondary" onClick={() => void library.refetch()}>Retry templates</button></Notice>}
    {library.data && <div className="email-workspace">
      <aside className="email-library" aria-label="Template library">
        <div className="email-library-heading"><h2>Template library</h2><span>{items.length}</span></div>
        <Field label="Search templates" type="search" placeholder="Search emails…" value={search} onChange={event => setSearch(event.target.value)}/>
        <div className="email-library-filters"><label className="field">Category<select value={category} onChange={event => setCategory(event.target.value)}><option value="">All categories</option><option value="account">Account &amp; security</option><option value="orders">Orders &amp; fulfillment</option></select></label><label className="field">Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option><option>Draft changes</option><option>Published</option><option>System default</option></select></label></div>
        <div className="email-template-list">{visible.map(template => <button type="button" key={template.key} className="email-template-card" aria-pressed={key === template.key} disabled={locked && key !== template.key} onClick={() => select(template.key)}>
          <span className="email-template-category">{labels[template.category]}</span><strong>{template.name}</strong><span className="email-template-description">{template.description}</span><span className="email-status" data-status={templateStatus(template)}>{templateStatus(template)}</span>
        </button>)}</div>
        {!visible.length && <div className="email-empty"><p>No templates match your filters.</p><button className="secondary" onClick={() => { setSearch(''); setCategory(''); setStatus(''); }}>Clear filters</button></div>}
        <p className="email-library-note">System defaults keep your transactional emails ready to send until you publish your own version.</p>
      </aside>
      <div className="email-detail">
        {detail.isPending && key && <div className="email-empty" role="status">Opening template…</div>}
        {detail.error && <Notice error>{detail.error.message}<button className="secondary" onClick={() => void detail.refetch()}>Retry template</button></Notice>}
        {detail.data && <EmailTemplateEditor key={key} initial={detail.data} canWrite={canWrite} canPublish={canPublish} onBusyChange={setLocked} onDirtyChange={setDirty}/>}
        {!key && <div className="email-empty">Email templates will appear here when available.</div>}
      </div>
    </div>}
  </main>;
}

export function EmailTemplateEditor({ initial, canWrite, canPublish, onBusyChange, onDirtyChange }: {
  initial: EmailTemplate; canWrite: boolean; canPublish: boolean; onBusyChange: (value: boolean) => void; onDirtyChange: (value: boolean) => void;
}) {
  const cache = useQueryClient();
  const fieldId = useId();
  const [record, setRecord] = useState(initial), [content, setContent] = useState(initial.draft);
  const [tab, setTab] = useState<WorkspaceTab>('content');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [conflict, setConflict] = useState(false);
  const [changeNote, setChangeNote] = useState(''), [publishNote, setPublishNote] = useState(''), [review, setReview] = useState(false);
  const [restore, setRestore] = useState<EmailTemplateVersion | null>(null), [restoreNote, setRestoreNote] = useState('');
  const [previewSource, setPreviewSource] = useState<'draft' | 'published'>('draft');
  const [format, setFormat] = useState<'html' | 'text'>('html'), [width, setWidth] = useState<'desktop' | 'mobile'>('desktop');
  const [preview, setPreview] = useState<{ snapshot: string; data: EmailTemplatePreview } | null>(null), [previewError, setPreviewError] = useState(''), [previewPending, setPreviewPending] = useState(false), [previewRetry, setPreviewRetry] = useState(0);
  const tabRefs = useRef<Partial<Record<WorkspaceTab, HTMLButtonElement | null>>>({});
  const focusedField = useRef<keyof EmailTemplateContent>('body');
  const fieldRefs = useRef<Partial<Record<keyof EmailTemplateContent, HTMLInputElement | HTMLTextAreaElement | null>>>({});
  const dirty = !sameEmailContent(content, record.draft);
  useUnsavedChanges(dirty);
  useEffect(() => { onDirtyChange(dirty); return () => onDirtyChange(false); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(busy); return () => onBusyChange(false); }, [busy, onBusyChange]);
  const problems = emailContentProblems(record, content);
  const history = useInfiniteQuery({
    queryKey: ['email-template-history', record.key], queryFn: ({ pageParam }) => emailTemplatesApi.history(record.key, pageParam),
    initialPageParam: undefined as number | undefined, getNextPageParam: page => page.next_before_version ?? undefined, enabled: tab === 'history',
  });
  const previewContent = previewSource === 'published' && record.published ? record.published : content;
  const previewSnapshot = JSON.stringify([record.key, record.revision, previewSource, previewContent]);
  const currentPreview = preview?.snapshot === previewSnapshot ? preview.data : null;
  const publishPreviewReady = tab === 'preview' && previewSource === 'draft' && !!currentPreview && !previewPending && !previewError;
  useEffect(() => {
    if (tab !== 'preview') return;
    const controller = new AbortController();
    setPreview(null); setPreviewError(''); setPreviewPending(true);
    const timeout = window.setTimeout(() => {
      void emailTemplatesApi.preview(record.key, previewContent, controller.signal).then(value => {
        if (!controller.signal.aborted) setPreview({ snapshot: previewSnapshot, data: value });
      }).catch(value => {
        if (!controller.signal.aborted) setPreviewError(value instanceof Error ? value.message : 'Preview is unavailable.');
      }).finally(() => { if (!controller.signal.aborted) setPreviewPending(false); });
    }, 400);
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [tab, record.key, previewContent, previewSnapshot, previewRetry]);
  function selectTab(next: WorkspaceTab, focus = false) {
    if (next === 'preview' && tab !== 'preview') { setPreview(null); setPreviewError(''); setPreviewPending(true); }
    setTab(next);
    if (focus) tabRefs.current[next]?.focus();
  }
  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, current: WorkspaceTab) {
    const index = workspaceTabs.findIndex(item => item.id === current);
    const next = event.key === 'ArrowRight' ? (index + 1) % workspaceTabs.length
      : event.key === 'ArrowLeft' ? (index + workspaceTabs.length - 1) % workspaceTabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? workspaceTabs.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); selectTab(workspaceTabs[next].id, true);
  }
  function reviewDraft() {
    setReview(true); setPreviewSource('draft'); selectTab('preview', true);
  }
  function change(field: keyof EmailTemplateContent, value: string) {
    setContent(current => ({ ...current, [field]: value })); setReview(false); setMessage(''); setPreviewSource('draft');
  }
  function insert(name: string) {
    const field = focusedField.current;
    const element = fieldRefs.current[field];
    const value = content[field] ?? '';
    const result = insertTemplateVariable(value, name, element?.selectionStart ?? value.length, element?.selectionEnd ?? value.length);
    change(field, result.value);
    requestAnimationFrame(() => { element?.focus(); element?.setSelectionRange(result.cursor, result.cursor); });
  }
  function accept(next: EmailTemplate) {
    setRecord(next); setContent(next.draft); setConflict(false); setChangeNote(''); setPublishNote(''); setRestoreNote(''); setReview(false); setRestore(null);
    cache.setQueryData(['email-template', next.key], next);
    cache.setQueryData<{ items: EmailTemplate[] }>(['email-templates'], previous => previous ? { items: previous.items.map(item => item.key === next.key ? next : item) } : previous);
    void cache.invalidateQueries({ queryKey: ['email-template-history', next.key] });
  }
  async function act(operation: () => Promise<EmailTemplate>, success: string) {
    setBusy(true); setError(''); setMessage('');
    try { accept(await operation()); setMessage(success); }
    catch (value) { setError(value instanceof Error ? value.message : 'Unable to update this template.'); setConflict(value instanceof ApiError && value.status === 409); }
    finally { setBusy(false); }
  }
  function save(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || busy || conflict || !dirty || problems.length || changeNote.trim().length < 3) return;
    void act(() => emailTemplatesApi.save(record.key, { expected_revision: record.revision, content, change_note: changeNote.trim() }), 'Draft saved. Customer emails will use this content after publication.');
  }
  function publish(event: FormEvent) {
    event.preventDefault();
    if (!canPublish || busy || conflict || dirty || !record.has_unpublished_changes || publishNote.trim().length < 3 || !review || !publishPreviewReady) return;
    void act(() => emailTemplatesApi.publish(record.key, { expected_revision: record.revision, change_note: publishNote.trim() }), 'Template published. New customer emails will use this version.');
  }
  function discard() {
    if (dirty && !window.confirm('Discard your unsaved email changes?')) return;
    setContent(record.draft); setChangeNote(''); setError(''); setReview(false); setMessage('');
  }
  async function reload() {
    if (dirty && !window.confirm('Discard your unsaved email changes and load the latest version?')) return;
    await act(() => emailTemplatesApi.get(record.key), 'Latest template loaded.');
  }
  const locked = busy || conflict;
  return <section className="email-editor" aria-label={`${record.name} template`}>
    <header className="email-editor-header"><div><span className="email-template-category">{labels[record.category]}</span><h2>{record.name}</h2><p>{record.description}</p></div><span className="email-status" data-status={templateStatus(record)}>{templateStatus(record)}</span></header>
    <div className="email-publishing-state"><span><i aria-hidden="true"/>{record.published_version === null ? 'System default is live' : `Version ${record.published_version} is live`}</span><small>{record.updated_at ? `Last updated ${dateLabel(record.updated_at)}` : 'Ready to customize'}</small><button type="button" className="secondary email-reload" disabled={busy} onClick={() => void reload()}>Reload latest version</button></div>
    <div className="email-workspace-nav"><div className="email-editor-tabs" role="tablist" aria-label="Template workspace">{workspaceTabs.map(item => <button key={item.id} ref={element => { tabRefs.current[item.id] = element; }} type="button" role="tab" id={`${fieldId}-tab-${item.id}`} aria-controls={`${fieldId}-panel-${item.id}`} aria-selected={tab === item.id} tabIndex={tab === item.id ? 0 : -1} onClick={() => selectTab(item.id)} onKeyDown={event => navigateTabs(event, item.id)}>{item.label}</button>)}</div>{dirty && <span className="email-unsaved">Unsaved changes</span>}</div>
    {error && <Notice error>{error}</Notice>}{message && <Notice>{message}</Notice>}
    {conflict && <div className="email-conflict"><p>Your changes are preserved below. Reload the latest version before saving, restoring, or publishing again.</p></div>}
    <div role="tabpanel" id={`${fieldId}-panel-content`} aria-labelledby={`${fieldId}-tab-content`} hidden={tab !== 'content'} tabIndex={0}>
      {!canWrite && <p className="email-read-only">{canPublish ? 'You can review and publish saved drafts. Editing requires draft editor access.' : 'View-only access. You can explore previews and published history.'}</p>}
        <form className="email-content-form" id="email-template-form" onSubmit={save}>
          <fieldset disabled={!canWrite || locked}><legend className="email-section-title">Email content</legend>
            <div className="field"><label htmlFor={`${fieldId}-subject`}>Subject line</label><input id={`${fieldId}-subject`} aria-describedby={`${fieldId}-subject-help`} ref={element => { fieldRefs.current.subject = element; }} required maxLength={200} value={content.subject} onFocus={() => { focusedField.current = 'subject'; }} onChange={event => change('subject', event.target.value)}/><small id={`${fieldId}-subject-help`}>The first thing customers see in their inbox.</small></div>
            <div className="field"><label htmlFor={`${fieldId}-heading`}>Heading</label><input id={`${fieldId}-heading`} ref={element => { fieldRefs.current.heading = element; }} required maxLength={160} value={content.heading} onFocus={() => { focusedField.current = 'heading'; }} onChange={event => change('heading', event.target.value)}/></div>
            <div className="field"><label htmlFor={`${fieldId}-body`}>Message body</label><textarea id={`${fieldId}-body`} aria-describedby={`${fieldId}-body-help`} ref={element => { fieldRefs.current.body = element; }} required maxLength={12000} rows={10} value={content.body} onFocus={() => { focusedField.current = 'body'; }} onChange={event => change('body', event.target.value)}/><small id={`${fieldId}-body-help`}>Write in plain text. Paragraphs are preserved in the email.</small></div>
            {content.cta_label !== null && <div className="field"><label htmlFor={`${fieldId}-button`}>Button label</label><input id={`${fieldId}-button`} aria-describedby={`${fieldId}-button-help`} ref={element => { fieldRefs.current.cta_label = element; }} required maxLength={80} value={content.cta_label} onFocus={() => { focusedField.current = 'cta_label'; }} onChange={event => change('cta_label', event.target.value)}/><small id={`${fieldId}-button-help`}>The secure account link is added automatically.</small></div>}
          </fieldset>
          <div className="email-variables"><h3>Personalization</h3><p>{canWrite ? 'Select a variable to insert it in the field you are editing.' : 'These values are filled in for each customer.'}</p><div>{record.variables.map(variable => <button type="button" key={variable.name} className="email-variable" disabled={!canWrite || locked} title={`${variable.description} Example: ${variable.sample}`} onClick={() => insert(variable.name)}><code>{`{{${variable.name}}}`}</code>{variable.required && <span>Required</span>}</button>)}</div><details><summary>Variable guide</summary><dl>{record.variables.map(variable => <div key={variable.name}><dt><code>{`{{${variable.name}}}`}</code></dt><dd>{variable.description}{variable.required && ' Keep this variable in the message body.'}<small>Sample: {variable.sample}</small></dd></div>)}</dl></details></div>
          {dirty && problems.length > 0 && <div className="email-validation" role="alert"><strong>Check your draft</strong><ul>{problems.map(problem => <li key={problem}>{problem}</li>)}</ul></div>}
          {canWrite && <div className="email-save-draft"><ReasonField label="Reason for this change" options={reasons} value={changeNote} onValueChange={setChangeNote} disabled={locked} maxLength={500}/><div className="email-actions"><button disabled={locked || !dirty || problems.length > 0 || changeNote.trim().length < 3}>{busy ? 'Saving…' : 'Save draft'}</button><button className="secondary" type="button" disabled={busy || !dirty} onClick={discard}>Discard changes</button></div></div>}
        </form>
    </div>
    <div role="tabpanel" id={`${fieldId}-panel-preview`} aria-labelledby={`${fieldId}-tab-preview`} hidden={tab !== 'preview'} tabIndex={0}>
        <section className="email-preview-panel" aria-label="Email preview">
          <div className="email-preview-heading"><div><h3>Customer email preview</h3><p>Review the complete message before it reaches your customers.</p></div><span>Sample customer data</span></div>
          <div className="email-preview-toolbar"><div className="email-preview-controls"><div role="group" aria-label="Preview source"><button type="button" aria-pressed={previewSource === 'draft'} onClick={() => setPreviewSource('draft')}>Draft</button>{record.published && <button type="button" aria-pressed={previewSource === 'published'} onClick={() => setPreviewSource('published')}>Live version</button>}</div><div role="group" aria-label="Preview format"><button type="button" aria-pressed={format === 'html'} onClick={() => setFormat('html')}>Email</button><button type="button" aria-pressed={format === 'text'} onClick={() => setFormat('text')}>Plain text</button></div></div>
          <div className="email-preview-device" role="group" aria-label="Preview size"><button type="button" aria-pressed={width === 'desktop'} onClick={() => setWidth('desktop')}>Desktop</button><button type="button" aria-pressed={width === 'mobile'} onClick={() => setWidth('mobile')}>Mobile</button></div></div>
          <div className="email-preview-stage" aria-busy={previewPending}>
            {previewPending && <div className="email-empty" role="status">Updating preview…</div>}
            {previewError && <div className="email-empty" role="alert"><p>{previewError}</p><button className="secondary" onClick={() => setPreviewRetry(value => value + 1)}>Retry preview</button></div>}
            {currentPreview && <div className={`email-preview-message ${width}`}><div className="email-preview-envelope"><span>Subject</span><strong>{currentPreview.subject}</strong><small>To: Alex Customer &lt;alex@example.com&gt;</small></div>{format === 'html' ? <iframe title={`${record.name} email preview`} sandbox="" referrerPolicy="no-referrer" srcDoc={currentPreview.html}/> : <pre aria-label="Plain text email preview">{currentPreview.text}</pre>}</div>}
          </div><p className="email-preview-caption">Preview only. No email is sent.</p>
        </section>
    </div>
    {tab !== 'history' && <footer className="email-publish-bar"><div><strong>{record.has_unpublished_changes ? 'Your saved draft is ready for review' : 'Customer emails are up to date'}</strong><p>{dirty ? 'Save your changes before publishing.' : record.has_unpublished_changes ? 'Publishing applies the saved draft to future customer emails.' : 'Changes stay in draft until they are published.'}</p></div>{canPublish ? <button type="button" disabled={locked || dirty || !record.has_unpublished_changes} onClick={() => { if (review && tab === 'preview') setReview(false); else reviewDraft(); }}>{review && tab === 'preview' ? 'Close review' : 'Review & publish'}</button> : record.has_unpublished_changes && <span className="email-access-label">Publisher approval required</span>}</footer>}
    {review && tab === 'preview' && <form className="email-publish-review" onSubmit={publish}><h3>Publish {record.name.toLowerCase()}?</h3><p>New customer emails will use the saved subject, message, and button shown in the draft preview. The current published version remains available in history.</p><ReasonField label="Publication note" options={reasons} value={publishNote} onValueChange={setPublishNote} disabled={locked} maxLength={500}/><div className="email-actions"><button disabled={locked || dirty || publishNote.trim().length < 3 || !publishPreviewReady}>{busy ? 'Publishing…' : 'Publish template'}</button><button type="button" className="secondary" disabled={busy} onClick={() => setReview(false)}>Cancel</button></div></form>}
    <div role="tabpanel" id={`${fieldId}-panel-history`} aria-labelledby={`${fieldId}-tab-history`} hidden={tab !== 'history'} tabIndex={0}>
    {tab === 'history' && <section className="email-history"><div className="email-history-heading"><h3>Published versions</h3><p>Restore a previous version as a draft, then review and publish it.</p></div>
      {history.isPending && <p role="status">Loading version history…</p>}
      {history.error && <Notice error>{history.error.message}<button className="secondary" onClick={() => void history.refetch()}>Retry history</button></Notice>}
      {history.data && !history.data.pages[0].items.length && <div className="email-empty"><MailIcon/><h3>No published versions yet</h3><p>Your first publication will appear here. The system default is currently live.</p></div>}
      {history.data?.pages.flatMap(page => page.items).map(version => <article key={version.version} className="email-version"><div className="email-version-marker">v{version.version}</div><div className="email-version-copy"><div><h4>Version {version.version}</h4>{record.published_version === version.version && <span className="email-status" data-status="Published">Live</span>}</div><p>{version.change_note}</p><small>{dateLabel(version.published_at)} · {version.published_by}</small><details><summary>View content</summary><dl><dt>Subject</dt><dd>{version.content.subject}</dd><dt>Heading</dt><dd>{version.content.heading}</dd><dt>Message</dt><dd className="email-version-body">{version.content.body}</dd>{version.content.cta_label !== null && <><dt>Button</dt><dd>{version.content.cta_label}</dd></>}</dl></details></div>{canWrite && <button type="button" className="secondary" disabled={locked || dirty || !!restore} title={dirty ? 'Save or discard unsaved changes first' : undefined} onClick={() => { setRestore(version); setRestoreNote('Restore a previous version'); }}>Restore as draft</button>}</article>)}
      {dirty && <p className="email-read-only">Save or discard your unsaved changes before restoring a version.</p>}
      {history.hasNextPage && <button className="secondary" disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>{history.isFetchingNextPage ? 'Loading…' : 'Load earlier versions'}</button>}
      {restore && <form className="email-publish-review" onSubmit={event => { event.preventDefault(); if (locked || dirty || !canWrite || restoreNote.trim().length < 3) return; void act(() => emailTemplatesApi.restore(record.key, { expected_revision: record.revision, version: restore.version, change_note: restoreNote.trim() }), `Version ${restore.version} restored as a draft. Review it before publication.`); }}><h3>Restore version {restore.version} as a draft?</h3><p>This replaces the saved draft. The current live email stays active until you publish.</p><ReasonField label="Restoration note" options={reasons} value={restoreNote} onValueChange={setRestoreNote} disabled={locked} maxLength={500}/><div className="email-actions"><button disabled={locked || dirty || restoreNote.trim().length < 3}>{busy ? 'Restoring…' : 'Confirm restore'}</button><button type="button" className="secondary" disabled={busy} onClick={() => setRestore(null)}>Cancel</button></div></form>}
    </section>}
    </div>
  </section>;
}
