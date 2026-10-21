import { useCallback, useId, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, languagesApi, type CatalogTranslation, type StorefrontLanguage, type TranslationKind } from '@commerce/api-client';
import { Notice } from '@commerce/ui';
import { useUnsavedChanges } from './unsaved-changes';
import { translatableEntries, translationComplete, translationField, translationStatus } from './entity-translation-model';
import './entity-translation.css';
import './editor-scope.css';

export type EditorState = { dirty: boolean; busy: boolean };
const clean: EditorState = { dirty: false, busy: false };
export function useEditorLanguage({ canRead, persisted, sourceDirty = false, sourceBusy = false, discardSource, disabled = false }: {
  canRead: boolean; disabled?: boolean; persisted: boolean; sourceDirty?: boolean; sourceBusy?: boolean; discardSource?: () => void;
}) {
  const query = useQuery({ queryKey: ['storefront-languages'], queryFn: languagesApi.list, enabled: canRead });
  const [locale, setLocale] = useState('');
  const [pendingLocale, setPendingLocale] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (pendingLocale === null || !dialog.current) return; const element = dialog.current; element.showModal(); return () => element.close(); }, [pendingLocale]);
  const [state, setState] = useState<EditorState>(clean);
  const language = query.data?.languages.find(item => item.locale === locale);
  const latestState = useRef<EditorState>(clean);
  const onEditorStateChange = useCallback((next: EditorState) => { latestState.current = next; setState(next); }, []);
  const busy = state.busy || sourceBusy;
  function switchLanguage(nextLocale: string) {
    if (!locale) discardSource?.();
    onEditorStateChange(clean); setLocale(nextLocale); setPendingLocale(null);
  }
  const toolbar = canRead ? <div className="editor-language-scope">
    <label>Content language<select aria-label="Content language" value={locale} disabled={disabled || busy || !query.data} onChange={event => {
      const nextLocale = event.currentTarget.value;
      if (latestState.current.busy || sourceBusy) { event.currentTarget.value = locale; return; }
      if (latestState.current.dirty || (!locale && sourceDirty)) { event.currentTarget.value = locale; setPendingLocale(nextLocale); }
      else switchLanguage(nextLocale);
    }}><option value="">{query.data ? `${new Intl.DisplayNames(['en'], {type:'language'}).of(query.data.source_locale) || query.data.source_locale} (${query.data.source_locale}) · Source / default` : 'Loading languages…'}</option>{query.data?.languages.map(item => <option key={item.locale} value={item.locale} disabled={!persisted}>{item.name} · {item.native_name} ({item.locale})</option>)}</select></label>
    {!persisted && <small>Save this record in the source language before translating.</small>}
    {query.data && persisted && !query.data.languages.length && <small>Add translation languages in Storefront → Languages.</small>}
    {query.error && <span role="alert">Languages could not be loaded. <button className="text-button" type="button" onClick={() => void query.refetch()}>Retry</button></span>}
    {pendingLocale !== null && <dialog ref={dialog} className="translation-switch-dialog" aria-labelledby="translation-switch-title" onCancel={() => setPendingLocale(null)}>
      <h2 id="translation-switch-title">Unsaved changes</h2><p>Discard your unsaved edits and switch the content language?</p>
      <div className="translation-editor-actions"><button type="button" className="secondary" autoFocus onClick={() => setPendingLocale(null)}>Keep editing</button><button type="button" onClick={() => switchLanguage(pendingLocale)}>Discard and switch</button></div>
    </dialog>}
  </div> : null;
  return { locale, language, toolbar, onEditorStateChange, dirty: state.dirty || sourceDirty, busy };
}

export type TranslationEditorFields = {
  source: Record<string, string>;
  values: Record<string, string>;
  field: (key: string, label?: string) => ReactNode;
};
export type TranslationReleaseState = EditorState & { reviewed: boolean; source: Record<string, string> };
type TranslationLayout = (editor: TranslationEditorFields) => ReactNode;

export function EntityTranslationEditor({ kind, id, language, canWrite, onStateChange, preview, renderEditor, renderRelease, externalBusy = false }: {
  kind: TranslationKind; id: string; language: StorefrontLanguage; canWrite: boolean;
  onStateChange: (state: EditorState) => void; preview?: (fields: Record<string, string>) => ReactNode; renderEditor?: TranslationLayout; renderRelease?: (state: TranslationReleaseState) => ReactNode; externalBusy?: boolean;
}) {
  const [generation, setGeneration] = useState(0);
  const query = useQuery({ queryKey: ['entity-translation', kind, id, language.locale], queryFn: () => languagesApi.translation(language.locale, kind, id), refetchOnWindowFocus: false, gcTime: 0 });
  if (query.isPending) return <p role="status">Loading {language.name} translation…</p>;
  if (!query.data) return <Notice error>{query.error?.message || 'Translation unavailable.'}<button type="button" className="secondary" onClick={() => void query.refetch()}>Retry translation</button></Notice>;
  return <TranslationForm key={generation} initial={query.data} kind={kind} language={language} canWrite={canWrite} onStateChange={onStateChange} preview={preview} renderEditor={renderEditor} renderRelease={renderRelease} externalBusy={externalBusy} reload={async () => { const result = await query.refetch(); if (result.error) throw result.error; setGeneration(value => value + 1); }}/>
}
function TranslationForm({ initial, kind, language, canWrite, onStateChange, reload, preview, renderEditor, renderRelease, externalBusy = false }: {
  initial: CatalogTranslation; kind: TranslationKind; language: StorefrontLanguage; canWrite: boolean;
  onStateChange: (state: EditorState) => void; reload: () => Promise<void>; preview?: (fields: Record<string, string>) => ReactNode; renderEditor?: TranslationLayout; renderRelease?: (state: TranslationReleaseState) => ReactNode; externalBusy?: boolean;
}) {
  const cache = useQueryClient();
  const formId = useId();
  const categoryLayout = kind === 'category' && !!renderEditor;
  // Keep the loaded source/revision stable while editing, including on background refresh.
  const [snapshot, setSnapshot] = useState(initial);
  const [fields, setFields] = useState(() => Object.fromEntries(Object.entries(initial.fields).filter(([key]) => translationField(key) && key in initial.source)));
  const [reviewed, setReviewed] = useState(initial.status === 'reviewed');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [message, setMessage] = useState('');
  const dirty = JSON.stringify(fields) !== JSON.stringify(snapshot.fields) || reviewed !== (snapshot.status === 'reviewed');
  const locked = busy || externalBusy;
  useUnsavedChanges(dirty);
  useLayoutEffect(() => { onStateChange({ dirty, busy: locked }); }, [dirty, locked, onStateChange]);
  function change(key: string, value: string | undefined) {
    setFields(current => { const next = { ...current }; if (value === undefined) delete next[key]; else next[key] = value; return next; }); setReviewed(false); setMessage('');
  }
  function renderField(key: string, label?: string) {
          const meta = translationField(key);
          if (!meta || !(key in snapshot.source)) return null;
          const source = snapshot.source[key];
          const fieldLabel = label ?? snapshot.source[`__label.${key}`] ?? meta.label;
          const inherited = !Object.prototype.hasOwnProperty.call(fields, key);
          return <div className="entity-translation-pair" key={key}>
            <details className="entity-translation-source"><summary>{fieldLabel} · Source</summary><p dir="auto">{source || 'No source text'}</p></details>
            <div className="entity-translation-control"><label className="field"><span>{fieldLabel} · {language.name}</span>{meta.multiline ? <textarea aria-label={`${fieldLabel} · ${language.name}`} dir={inherited ? 'auto' : language.direction} lang={inherited ? undefined : language.locale} rows={5} maxLength={kind === 'attribute' && key === 'description' ? 2000 : meta.maxLength} disabled={inherited || locked || !canWrite || conflict} placeholder={source} value={inherited ? source : fields[key] ?? ''} onChange={event => change(key, event.target.value)} /> : <input aria-label={`${fieldLabel} · ${language.name}`} dir={inherited ? 'auto' : language.direction} lang={inherited ? undefined : language.locale} maxLength={kind === 'attribute' && key === 'description' ? 2000 : meta.maxLength} disabled={inherited || locked || !canWrite || conflict} placeholder={source} value={inherited ? source : fields[key] ?? ''} onChange={event => change(key, event.target.value)} />}</label>
            <label className="translation-inherit"><input type="checkbox" disabled={locked || !canWrite || conflict} checked={inherited} onChange={event => change(key, event.target.checked ? undefined : '')}/><span>Use source value for {fieldLabel.toLowerCase()}</span></label></div>
          </div>;
  }
  const complete = translationComplete(snapshot.source, fields);
  const fallback = { ...snapshot.source, ...Object.fromEntries(translatableEntries(snapshot.source).map(([key, value]) => [key, fields[key]?.trim() ? fields[key] : value])) };
  return <section className={`entity-translation ${renderEditor ? "entity-translation-native" : "form-card"}`}>
    <div className={`entity-translation-heading${categoryLayout ? ' category-detail-heading' : ''}`}><div><h2 dir={categoryLayout ? language.direction : undefined} lang={categoryLayout ? language.locale : undefined}>{categoryLayout ? fallback.name : `${language.name} content`}</h2><p>{categoryLayout ? `${language.native_name} · ${language.name} content · Source: ${snapshot.name}` : <>Editing {kind === 'navigation' ? 'megamenu' : kind} translations for <strong>{snapshot.name}</strong>.</>}</p></div><div className="translation-heading-actions"><span className="badge">{dirty ? 'Unsaved changes' : translationStatus[snapshot.status]}</span>{categoryLayout && canWrite && <button form={formId} disabled={locked || !dirty || conflict}>{busy ? 'Saving…' : reviewed ? 'Save reviewed translation' : 'Save translation draft'}</button>}</div></div>
    <p className="translation-scope-note">{kind === 'navigation' ? 'Links, item order, icons and visibility are shared across languages.' : kind === 'attribute' ? 'Attribute codes, input types, option values and validation settings are shared across languages.' : kind === 'product' ? 'SKU, prices, stock, images and category assignments are shared across languages.' : 'The URL key, parent category, images and non-text attribute values are shared across languages.'} Edit shared settings in the source language.</p>
    <p className="help">{kind === 'attribute' ? 'Mark translations reviewed to show labels and option labels in the selected storefront language. Missing translations use the source language.' : kind === 'navigation' ? (renderRelease ? 'Save and review this translation, then publish or schedule the menu below. Later edits stay private until the next release.' : 'Mark translations reviewed, then publish the matching source menu to show them on the storefront. Later translation edits stay private until you publish again.') : 'Translations are saved for this language only. Storefront language publication is not available yet.'}</p>
    {snapshot.status === 'needs_review' && <Notice>The source changed. Check every translation against the current source before marking it reviewed.{kind === 'navigation' && ' Menu items may have moved or changed.'}</Notice>}
    {!canWrite && <Notice>View-only translation. Language and {kind === 'navigation' ? 'content' : kind === 'attribute' ? 'attribute' : 'catalog'} editing permissions are required to save.</Notice>}
    <form id={formId} onSubmit={async event => {
      event.preventDefault(); if (!canWrite || locked || conflict) return;
      setBusy(true); setError(''); setMessage('');
      try {
        const saved = await languagesApi.saveTranslation(language.locale, kind, snapshot.entity_id, { expected_revision: snapshot.revision, source: snapshot.source, fields, reviewed });
        const next = { ...snapshot, fields, revision: saved.revision, status: saved.status };
        setSnapshot(next); cache.setQueryData(['entity-translation', kind, snapshot.entity_id, language.locale], next);
        void cache.invalidateQueries({ queryKey: ['catalog-translations'] });
        setMessage(`${language.name} translation saved${reviewed ? ' and reviewed' : ' as a draft'}.`);
      } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to save translation'); setConflict(cause instanceof ApiError && cause.status === 409); }
      finally { setBusy(false); }
    }}>
      {renderEditor?.({source:snapshot.source, values:fallback, field:renderField})}
      <fieldset disabled={locked || !canWrite || conflict}><legend className="sr-only">{language.name} translation fields</legend>
        {!renderEditor && translatableEntries(snapshot.source).map(([key]) => renderField(key))}
        <label className="translation-review"><input type="checkbox" checked={reviewed} disabled={!complete} onChange={event => setReviewed(event.target.checked)}/><span>I reviewed this translation against the current source</span></label>
        {!complete && <p className="help">Translate each nonempty source field to mark this record reviewed. You can save partial translations as a draft.</p>}
      </fieldset>
      <Notice error>{error}</Notice><Notice>{message}</Notice>
      <div className="translation-editor-actions">{canWrite && !categoryLayout && <button disabled={locked || !dirty || conflict}>{busy ? 'Saving…' : reviewed ? 'Save reviewed translation' : 'Save translation draft'}</button>}
        <button type="button" className="secondary" disabled={locked} onClick={async () => {
          if (dirty && !window.confirm('Discard unsaved translation changes and reload?')) return;
          setBusy(true); try { await reload(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to reload translation'); setBusy(false); }
        }}>Reload saved translation</button></div>
    </form>
    {renderRelease?.({dirty, busy, reviewed: snapshot.status === 'reviewed' && !conflict, source: snapshot.source})}
    {preview && <details className="translation-editor-preview"><summary>Preview {language.name} content</summary><div dir={language.direction} lang={language.locale}>{preview(fallback)}</div></details>}
  </section>;
}
