import { translatableEntries, translationField } from "./entity-translation-model";
import { InterfaceTranslations } from "./interface-translations";
import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, marketsApi, languagesApi, type CatalogTranslation, type LanguageInput, type StorefrontLanguage, type TranslationKind } from '@commerce/api-client';
import { Field, Notice } from '@commerce/ui';
import { PageHeader } from './page-header';
import { Link } from 'react-router-dom';
import { languageMarkets, matchesLanguage } from './language-market-model';
import { useUnsavedChanges } from './unsaved-changes';
import './languages.css';

const statusLabels = { missing: 'Missing', draft: 'Draft', needs_review: 'Source changed', reviewed: 'Reviewed' };
const blank: LanguageInput = {locale: 'ar', name: 'Arabic', native_name: 'العربية', direction: 'rtl', expected_revision: 0};

export function StorefrontLanguages({ canWrite, canReadMarkets = false, canReadCatalog, canWriteCatalog, canReadContent = false, canWriteContent = false, canReadAttributes = false, canWriteAttributes = false }: { canWrite: boolean; canReadMarkets?: boolean; canReadCatalog: boolean; canWriteCatalog: boolean; canReadContent?: boolean; canWriteContent?: boolean; canReadAttributes?: boolean; canWriteAttributes?: boolean }) {
  const [workspace, setWorkspace] = useState<'catalog'|'interface'>('catalog');
  const cache = useQueryClient();
  const query = useQuery({queryKey: ['storefront-languages'], queryFn: languagesApi.list});
  const markets = useQuery({queryKey: ['markets'], queryFn: marketsApi.list, enabled: canReadMarkets});
  const [selected, setSelected] = useState(''), [search, setSearch] = useState(''), [marketId, setMarketId] = useState('');
  const [editing, setEditing] = useState<LanguageInput | null>(null);
  const [editorLocked, setEditorLocked] = useState(false);
  const language = query.data?.languages.find(item => item.locale === selected);
  const canTranslate = canReadCatalog || canReadContent || canReadAttributes;
  const source = query.data?.source_locale;
  const rows = query.data ? [{locale: query.data.source_locale, name: new Intl.DisplayNames(['en'], {type:'language'}).of(query.data.source_locale) || query.data.source_locale, native_name: '', direction: query.data.source_locale.split('-')[0] === 'ar' ? 'rtl' : 'ltr'}, ...query.data.languages] : [];
  const visible = rows.filter(item => matchesLanguage(item, search, marketId, markets.data?.items ?? []));
  return <main className="languages-page">
    <PageHeader title="Languages" actions={<>{canReadMarkets && <Link className="language-market-link" to="/storefront/markets">Manage markets ↗</Link>}{canWrite && workspace === 'catalog' && <button disabled={!query.data || !!editing || editorLocked} onClick={() => setEditing({...blank, ...(source === 'ar' ? {locale:'en',name:'English',native_name:'English',direction:'ltr' as const} : {})})}>Add language</button>}</>} />
    <nav className="language-workspace-nav" aria-label="Translation workspace"><button className="secondary" disabled={!!editing || editorLocked} aria-pressed={workspace==='catalog'} onClick={()=>setWorkspace('catalog')}>Languages & content</button><button className="secondary" disabled={!!editing || editorLocked} aria-pressed={workspace==='interface'} onClick={()=>setWorkspace('interface')}>Shopping interface</button></nav>
    {workspace === 'interface' ? <InterfaceTranslations canWrite={canWrite} onEditorLock={setEditorLocked}/> : <>
      {query.isPending && <p role="status">Loading languages…</p>}
      {query.error && <Notice error>{query.error.message}<button type="button" onClick={() => void query.refetch()}>Retry</button></Notice>}
      {query.data && <>
        <div className="language-overview"><div><span className="language-eyebrow">SOURCE LANGUAGE</span><strong>{source?.toUpperCase()}</strong></div><div><span className="language-eyebrow">LANGUAGES</span><strong>{rows.length}</strong></div><div><span className="language-eyebrow">SCOPE</span><strong>Shared across markets</strong></div></div>
        <section className="form-card language-registry" aria-label="Language registry">
          <div className="language-section-heading"><h2>Languages</h2>{!canWrite && <span className="language-badge">View only</span>}</div>
          <div className="language-registry-toolbar"><Field label="Search languages" type="search" value={search} onChange={event => setSearch(event.target.value)} />{canReadMarkets && <label className="field">Market<select aria-label="Market" value={marketId} disabled={!markets.data} onChange={event => setMarketId(event.target.value)}><option value="">All markets</option>{markets.data?.items.map(market => <option key={market.id} value={market.id}>{market.name}</option>)}</select></label>}</div>
          {canReadMarkets && markets.isPending && <p role="status">Loading market assignments…</p>}
          {canReadMarkets && markets.error && <Notice error>{markets.error.message}<button type="button" onClick={() => void markets.refetch()}>Retry markets</button></Notice>}
          <div className="translation-table language-registry-table"><table><thead><tr><th scope="col">Language</th><th scope="col">Locale</th><th scope="col">Direction</th>{canReadMarkets && <th scope="col">Market assignments · Draft</th>}<th scope="col">Actions</th></tr></thead><tbody>{visible.map(item => <tr key={item.locale} data-selected={selected === item.locale}>
            <td data-label="Language"><strong><bdi>{item.native_name || item.name}</bdi></strong>{item.native_name && <small>{item.name}</small>}{item.locale === source && <span className="language-badge">Source · Fallback</span>}</td>
            <td data-label="Locale"><code>{item.locale}</code></td><td data-label="Direction">{item.direction ? item.direction.toUpperCase() : '—'}</td>
            {canReadMarkets && <td data-label="Market assignments · Draft">{markets.data ? languageMarkets(item.locale, markets.data.items).length ? <div className="language-market-tags">{languageMarkets(item.locale, markets.data.items).map(market => <span className="language-market-tag" key={market.id}>{market.name}{market.isDefault && <small>Default</small>}</span>)}</div> : <span className="language-muted">Unassigned</span> : '—'}</td>}
            <td data-label="Actions"><div className="language-row-actions">{item.locale !== source && <>{canTranslate && <button className="secondary" disabled={!!editing || editorLocked} aria-pressed={selected === item.locale} onClick={() => setSelected(item.locale)}>Translations</button>}{canWrite && <button className="secondary" disabled={!!editing || editorLocked} onClick={() => {const found = query.data.languages.find(value => value.locale === item.locale)!; const {revision, ...values} = found; setEditing({...values, expected_revision: revision});}}>Edit language</button>}</>}</div></td>
          </tr>)}</tbody></table></div>
          {!visible.length && <div className="language-empty"><h3>No matching languages</h3><button type="button" className="secondary" onClick={() => {setSearch('');setMarketId('');}}>Clear filters</button></div>}
        </section>
      </>}
      {editing && <LanguageForm key={`${editing.locale}-${editing.expected_revision}`} initial={editing} onEditorLock={setEditorLocked} close={() => {setEditing(null);setEditorLocked(false);}} saved={item => {void cache.invalidateQueries({queryKey:['storefront-languages']}); void cache.invalidateQueries({queryKey:['markets']}); setEditing(null); setEditorLocked(false); setSelected(item.locale);}} />}
      {language && canTranslate && !editing && <TranslationWorkspace key={language.locale} language={language} onEditorLock={setEditorLocked} canReadCatalog={canReadCatalog} canReadContent={canReadContent} canWriteCatalog={canWrite && canWriteCatalog} canWriteContent={canWrite && canWriteContent} canReadAttributes={canReadAttributes} canWriteAttributes={canWrite && canWriteAttributes} />}
    </>}
  </main>;
}

function LanguageForm({ initial: original, close, saved, onEditorLock }: { onEditorLock: (locked: boolean) => void; initial: LanguageInput; close: () => void; saved: (value: StorefrontLanguage) => void }) {
  const [initial, setInitial] = useState(original);
  const [conflict, setConflict] = useState(false);
  const [form, setForm] = useState(original), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const allowLeave = useUnsavedChanges(dirty);
  useEffect(() => {onEditorLock(dirty || busy);}, [dirty, busy, onEditorLock]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { const item = await languagesApi.save({...form,locale:form.locale.trim(),name:form.name.trim(),native_name:form.native_name.trim()}); allowLeave(); saved(item); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save language'); setConflict(e instanceof ApiError && e.status === 409); } finally { setBusy(false); }
  }
  return <form className="form-card" onSubmit={submit}><h2>{initial.expected_revision ? 'Edit language' : 'Add language'}</h2>
    <fieldset disabled={busy || conflict}><legend className="sr-only">Language details</legend><div className="form-grid">
      <Field label="Locale code" required maxLength={35} disabled={initial.expected_revision > 0} value={form.locale} placeholder="ar or ar-EG" onChange={e => setForm({...form,locale:e.target.value})} />
      <Field label="Language name" required maxLength={80} value={form.name} onChange={e => setForm({...form,name:e.target.value})} />
      <Field label="Native name" required maxLength={80} dir="auto" value={form.native_name} onChange={e => setForm({...form,native_name:e.target.value})} />
      <label className="field">Reading direction<select value={form.direction} onChange={e => setForm({...form,direction:e.target.value as 'ltr'|'rtl'})}><option value="ltr">Left to right</option><option value="rtl">Right to left</option></select></label>
    </div>
    <div className="language-actions"><button>{busy ? 'Saving…' : 'Save language'}</button><button type="button" className="secondary" onClick={() => {if (!dirty || window.confirm('Discard unsaved language changes?')) {allowLeave();close();}}}>Cancel</button></div></fieldset><Notice error>{error}</Notice>
    {conflict && <button type="button" className="secondary" disabled={busy} onClick={async () => {
      if (dirty && !window.confirm('Discard unsaved language changes and reload?')) return;
      setBusy(true);
      try {
        const settings = await languagesApi.list();
        const latest = settings.languages.find(item => item.locale === initial.locale);
        const next = latest ? {locale:latest.locale,name:latest.name,native_name:latest.native_name,direction:latest.direction,expected_revision:latest.revision} : {...initial,expected_revision:0};
        setInitial(next);setForm(next);setConflict(false);setError('');
      } catch (cause) {setError(cause instanceof Error ? cause.message : 'Unable to reload language');}
      finally {setBusy(false);}
    }}>Reload latest version</button>}
    {conflict && <button type="button" className="secondary" disabled={busy} onClick={() => {if (!dirty || window.confirm('Discard unsaved language changes?')) {allowLeave();close();}}}>Cancel</button>}
  </form>;
}

function TranslationWorkspace({ onEditorLock, language, canReadCatalog, canReadContent, canWriteCatalog, canWriteContent, canReadAttributes, canWriteAttributes }: { onEditorLock: (locked: boolean) => void; language: StorefrontLanguage; canReadCatalog: boolean; canReadContent: boolean; canWriteCatalog: boolean; canWriteContent: boolean; canReadAttributes: boolean; canWriteAttributes: boolean }) {
  const [kind,setKind] = useState<TranslationKind>(canReadCatalog ? 'product' : canReadAttributes ? 'attribute' : 'navigation'), [q,setQ] = useState(''), [search,setSearch] = useState(''), [offset,setOffset] = useState(0);
  const canWrite = kind === "navigation" ? canWriteContent : kind === "attribute" ? canWriteAttributes : canWriteCatalog;
  const [editing,setEditing] = useState<CatalogTranslation|null>(null);
  const query = useQuery({queryKey:['catalog-translations',language.locale,kind,search,offset],queryFn:() => languagesApi.translations(language.locale,kind,search,offset)});
  // Switching records is explicit; an open draft is never overwritten by background refreshes.
  return <section className="form-card catalog-workspace" aria-label={`${language.name} translations`}><div className="language-section-heading"><div><span className="language-eyebrow">TRANSLATION WORKSPACE · {language.locale.toUpperCase()}</span><h2>{language.name} translations</h2></div><span className="language-badge">{language.direction === 'rtl' ? 'Right to left' : 'Left to right'}</span></div>
    {editing ? <TranslationEditor onEditorLock={onEditorLock} key={`${kind}-${editing.entity_id}`} language={language} kind={kind} initial={editing} canWrite={canWrite} close={() => {setEditing(null); onEditorLock(false); void query.refetch();}} saved={() => {setEditing(null); onEditorLock(false); void query.refetch();}} /> : <>
      <form className="language-actions" onSubmit={e => {e.preventDefault(); setSearch(q); setOffset(0);}}>
        <label>Content<select value={kind} onChange={e => {setKind(e.target.value as TranslationKind); setOffset(0);}}>{canReadCatalog && <><option value="product">Products</option><option value="category">Categories</option></>}{canReadAttributes && <option value="attribute">Attributes</option>}{canReadContent && <option value="navigation">Navigation</option>}</select></label>
        <Field label="Search source names" maxLength={200} value={q} onChange={e => setQ(e.target.value)} /><button className="secondary">Search</button>
      </form>
      {query.isPending && <p role="status">Loading translations…</p>}
      {query.error && <Notice error>{query.error.message}<button type="button" onClick={() => void query.refetch()}>Retry</button></Notice>}
      {query.data && <>
        <div className="translation-summary" role="status" aria-label="Translation status">{(['reviewed','draft','needs_review','missing'] as const).map(status => <div key={status}><span className={`translation-status status-${status}`}>{statusLabels[status]}</span><strong>{query.data[status]}</strong></div>)}</div>{search && <p className="help">Showing results for “{search}”. <button type="button" className="secondary" onClick={() => {setQ('');setSearch('');setOffset(0);}}>Clear search</button></p>}
        <div className="translation-table"><table><thead><tr><th scope="col">Source name</th><th scope="col">Translation</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead><tbody>{query.data.items.map(row => <tr key={row.entity_id}><td data-label="Source name">{row.name}</td><td data-label="Translation" lang={language.locale} dir={language.direction}>{row.fields.name || row.fields.label || row.fields.title || '—'}</td><td data-label="Status"><span className={`translation-status status-${row.status}`}>{statusLabels[row.status]}</span></td><td data-label="Action"><button className="secondary" onClick={() => setEditing(row)}>{canWrite ? 'Translate' : 'View'}</button></td></tr>)}</tbody></table></div>
        {!query.data.items.length && <div className="language-empty"><h3>{search ? 'No results found' : 'No content to translate yet'}</h3><p>{search ? 'Try another source name or clear your search.' : 'Content added in the source screens will appear here.'}</p></div>}
        <div className="language-actions"><button className="secondary" disabled={!offset} onClick={() => setOffset(Math.max(0,offset-50))}>Previous</button><span>{query.data.total ? offset+1 : 0}–{offset+query.data.items.length} of {query.data.total}</span><button className="secondary" disabled={offset+50 >= query.data.total} onClick={() => setOffset(offset+50)}>Next</button></div>
      </>}
    </>}
  </section>;
}

function TranslationEditor({ onEditorLock, language, kind, initial: original, canWrite, close, saved }: { onEditorLock: (locked: boolean) => void; language: StorefrontLanguage; kind: TranslationKind; initial: CatalogTranslation; canWrite: boolean; close: () => void; saved: () => void }) {
  const [initial,setInitial] = useState(original), [conflict,setConflict] = useState(false);
  const [fields,setFields] = useState(original.fields), [reviewed,setReviewed] = useState(original.status === "reviewed"), [busy,setBusy] = useState(false), [error,setError] = useState('');
  const dirty = JSON.stringify(fields) !== JSON.stringify(initial.fields) || reviewed !== (initial.status === "reviewed");
  const allowLeave = useUnsavedChanges(dirty);
  useEffect(() => {onEditorLock(dirty || busy);}, [dirty, busy, onEditorLock]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!canWrite) return; setBusy(true); setError('');
    try { await languagesApi.saveTranslation(language.locale,kind,initial.entity_id,{expected_revision:initial.revision,source:initial.source,fields,reviewed}); allowLeave(); saved(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Unable to save translation'); setConflict(e instanceof ApiError && e.status === 409); }
    finally { setBusy(false); }
  }
  return <form onSubmit={submit}><h3>{initial.name}</h3>
    {initial.status === 'needs_review' && <Notice>The source changed since this translation was saved. Review the current source below before approving.</Notice>}
    <fieldset disabled={busy || conflict || !canWrite}><legend className="sr-only">Translation fields</legend>
      {translatableEntries(initial.source).map(([key,value]) => <div className="translation-pair" key={key}><div><strong>{translationField(key)!.label} · Source</strong><p className="translation-source" dir="auto">{value || 'Empty'}</p></div><label className="field">{translationField(key)!.label} · {language.name}<textarea dir={language.direction} lang={language.locale} rows={key === 'name' ? 2 : 6} maxLength={translationField(key)!.maxLength} value={fields[key] ?? ''} onChange={e => {setFields({...fields,[key]:e.target.value}); setReviewed(false);}} /></label></div>)}
      <label><input type="checkbox" checked={reviewed} onChange={e => setReviewed(e.target.checked)} /> I reviewed this translation against the current source</label>
    </fieldset>
    <details><summary>Preview translated text</summary><article className="translation-preview" dir={language.direction} lang={language.locale}><h3>{fields.name || fields.label || fields.title || '—'}</h3>{kind === 'product' && <p>{fields.description || '—'}</p>}</article></details>
    <Notice error>{error}</Notice>
    {conflict && <button type="button" className="secondary" disabled={busy} onClick={async () => {
      if (dirty && !window.confirm('Discard unsaved translation changes and reload?')) return;
      setBusy(true);
      try {
        const latest = await languagesApi.translation(language.locale,kind,initial.entity_id);
        setInitial(latest);setFields(latest.fields);setReviewed(latest.status === 'reviewed');setConflict(false);setError('');
      } catch (cause) {setError(cause instanceof Error ? cause.message : 'Unable to reload translation');}
      finally {setBusy(false);}
    }}>Reload latest version</button>}
    <div className="language-actions">{canWrite && <button disabled={busy || conflict || !dirty}>{busy ? 'Saving…' : reviewed ? 'Save reviewed translation' : 'Save draft'}</button>}<button type="button" className="secondary" disabled={busy} onClick={() => {if (!dirty || window.confirm('Discard unsaved translation changes?')) {allowLeave();close();}}}>Back to list</button></div>
  </form>;
}
