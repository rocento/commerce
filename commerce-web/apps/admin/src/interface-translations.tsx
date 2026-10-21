import { InterfaceStorefrontPreview } from "./interface-storefront-preview";
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, interfaceTranslationsApi as api, interfaceText, formatInterfaceMessage, type InterfaceBundle, type InterfaceEdit, type InterfaceLocale, type InterfaceMessage, type InterfacePreview, type PluralForm } from '@commerce/api-client';
import { Field, Notice } from '@commerce/ui';

import { useUnsavedChanges } from './unsaved-changes';

const forms: PluralForm[] = ['zero','one','two','few','many','other'];
const samples = {zero:0,one:1,two:2,few:3,many:11,other:100};
const errorText = (e: unknown) => e instanceof Error ? e.message : 'Unable to update translations';
type Editing = {input: InterfaceEdit; source: string; plural: boolean; bundle: InterfaceBundle};

export function InterfaceTranslations({canWrite, onEditorLock}: {canWrite: boolean; onEditorLock?: (locked: boolean) => void}) {
  const [storefrontPreview,setStorefrontPreview] = useState(false);
  const query = useQuery({queryKey:['interface-translations'],queryFn:api.get});
  const file = useRef<HTMLInputElement>(null);
  const [page,setPage] = useState(0);
  const [locale,setLocale] = useState<InterfaceLocale>('ar'), [search,setSearch] = useState('');
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [preview,setPreview] = useState<{csv:string; data:InterfacePreview}|null>(null), [editing,setEditing] = useState<Editing|null>(null);
  useEffect(() => {onEditorLock?.(busy || !!preview);}, [busy, preview, onEditorLock]);
  async function exportCsv() {
    setBusy(true);setError('');
    try { const url=URL.createObjectURL(await api.export()); const link=document.createElement('a');link.href=url;link.download='storefront-interface.csv';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
    catch(e) {setError(errorText(e));} finally {setBusy(false);}
  }
  async function previewCsv(csv: string) {
    setBusy(true);setError('');setNotice('');setPreview(null);
    try {setPreview({csv,data:await api.preview(csv)});} catch(e){setError(errorText(e));} finally{setBusy(false);}
  }
  async function upload(selected: File | undefined) {
    if (!selected) return;
    setPreview(null);setError('');setNotice('');
    if (selected.size > 256*1024) {setError('Choose a UTF-8 CSV file no larger than 256 KiB.');return;}
    setBusy(true);
    try {await previewCsv(new TextDecoder('utf-8',{fatal:true}).decode(await selected.arrayBuffer()));}
    catch {setError('The file is not valid UTF-8. Save it as CSV UTF-8 and try again.');}
    finally {setBusy(false);}
  }
  async function apply() {
    if (!preview || !canWrite || preview.data.errors.length) return;
    setBusy(true);setError('');
    try { const result=await api.apply(preview.csv,preview.data);setPreview(null);setNotice(`${result.changed} interface translations saved to the storefront.`);await query.refetch(); }
    catch(e){setError(errorText(e));} finally{setBusy(false);}
  }
  function open(message: InterfaceMessage, form: PluralForm) {
    const bundle=query.data!;
    setEditing({bundle,source:message[locale][form]!,plural:!!message.plural,input:{key:message.key,locale,form,text:interfaceText(bundle,message,locale,form),expected_revision:bundle.revision,catalog_version:bundle.catalog_version}});
  }
  const phraseRows = query.data?.messages.filter(message => [message.key, ...Object.values(message.en), ...Object.values(message.ar), ...query.data!.overrides.filter(override => override.key === message.key).map(override => override.text)].join(' ').toLocaleLowerCase().includes(search.toLocaleLowerCase())).flatMap(message => forms.filter(form => message[locale][form] !== undefined).map(form => ({message, form}))) ?? [];
  const pageStart = Math.min(page * 50, Math.max(0, Math.ceil(phraseRows.length / 50) - 1) * 50);
  if(storefrontPreview)return <InterfaceStorefrontPreview close={()=>setStorefrontPreview(false)}/>;
  return <section className="form-card interface-workspace"><h2>Shopping interface</h2>
    <p className="language-muted">Shared phrases · English and Arabic · Changes apply immediately</p>
    {editing ? <InterfaceEditor onEditorLock={onEditorLock} initial={editing} canWrite={canWrite} close={() => {setEditing(null);onEditorLock?.(false);void query.refetch();}} saved={() => {setEditing(null);onEditorLock?.(false);setNotice('Interface translation saved.');void query.refetch();}}/> : <>
      <div className="language-actions"><button className="secondary" disabled={busy || !query.data || !!preview} onClick={()=>setStorefrontPreview(true)}>Preview storefront</button><button className="secondary" disabled={busy || !query.data} onClick={() => void exportCsv()}>Export CSV</button>{canWrite && <><button className="secondary" disabled={busy} onClick={() => file.current?.click()}>Import CSV</button><input ref={file} hidden type="file" accept=".csv,text/csv" aria-label="Import interface CSV" onChange={e => {const selected=e.target.files?.[0];e.target.value='';void upload(selected);}}/></>}</div>
      <details><summary>CSV format</summary><p><code>key,form,en,ar</code> · UTF-8 · 256 KiB maximum. Export a template to preserve plural forms and placeholders.</p><p>Blank cells keep existing text. Review the import before applying changes.</p></details>
      <Notice error>{error || query.error?.message}</Notice><Notice>{notice}</Notice>
      {query.error && <button className="secondary" onClick={() => void query.refetch()}>Reload translations</button>}
      {busy && <p role="status">Processing translations…</p>}
      {preview && <section className="interface-import-preview" aria-label="CSV import preview"><h3>Import preview</h3><p>{preview.data.changes.length} proposed changes · {preview.data.errors.length} errors. Nothing has been saved.</p>
        {!!preview.data.errors.length && <ul role="alert">{preview.data.errors.map((item,index)=><li key={index}>Row {item.row}, {item.field}: {item.message}</li>)}</ul>}
        {!!preview.data.changes.length && <div className="translation-table"><table><thead><tr><th>Key / form</th><th>Language</th><th>Current</th><th>Proposed</th></tr></thead><tbody>{preview.data.changes.map(item=><tr key={`${item.key}-${item.locale}-${item.form}`}><td data-label="Key / form">{item.key}<br/>{item.form}</td><td data-label="Language">{item.locale}</td><td data-label="Current" dir={item.locale==='ar'?'rtl':'ltr'}>{item.before}</td><td data-label="Proposed" dir={item.locale==='ar'?'rtl':'ltr'}>{item.after}</td></tr>)}</tbody></table></div>}
        <div className="language-actions"><button disabled={busy || !canWrite || !!preview.data.errors.length || !preview.data.changes.length} onClick={() => void apply()}>Apply {preview.data.changes.length} changes</button><button className="secondary" disabled={busy} onClick={() => void previewCsv(preview.csv)}>Refresh preview</button><button className="secondary" disabled={busy} onClick={() => setPreview(null)}>Cancel import</button></div>
      </section>}
      {query.isPending && <p role="status">Loading interface phrases…</p>}
      {query.data && <>
        <div className="language-actions"><label className="field">Language<select value={locale} disabled={busy} onChange={e=>{setLocale(e.target.value as InterfaceLocale);setPage(0);}}><option value="en">English</option><option value="ar">العربية — Arabic</option></select></label><Field label="Search phrases or keys" value={search} onChange={e=>{setSearch(e.target.value);setPage(0);}}/></div>
        <div className="translation-table"><table><thead><tr><th>Key / form</th><th>Text</th><th>Status</th><th>Action</th></tr></thead><tbody>{phraseRows.slice(pageStart, pageStart + 50).map(({message:m, form})=>{
          const override=query.data!.overrides.find(o=>o.key===m.key && o.locale===locale && o.form===form);
          return <tr key={`${m.key}-${form}`}><td data-label="Key / form"><code>{m.key}</code>{m.plural && <><br/><small>{form}</small></>}</td><td data-label="Text" dir={locale==='ar'?'rtl':'ltr'} lang={locale}>{interfaceText(query.data!,m,locale,form)}</td><td data-label="Status">{override ? override.source_text!==m[locale][form] ? 'Source changed' : 'Custom translation' : 'Built-in'}</td><td data-label="Action"><button className="secondary" disabled={busy || !!preview} onClick={()=>open(m,form)}>{canWrite?'Edit':'View'}</button></td></tr>;
        })}</tbody></table></div>
        {!phraseRows.length && <p role="status">No matching phrases.</p>}
        <div className="language-actions"><button className="secondary" disabled={!pageStart || busy} onClick={() => setPage(Math.max(0,page - 1))}>Previous</button><span>{phraseRows.length ? pageStart + 1 : 0}–{Math.min(pageStart + 50,phraseRows.length)} of {phraseRows.length}</span><button className="secondary" disabled={pageStart + 50 >= phraseRows.length || busy} onClick={() => setPage(page + 1)}>Next</button></div>
      </>}
    </>}
  </section>;
}

function InterfaceEditor({initial:original,canWrite,close,saved,onEditorLock}: {onEditorLock?: (locked: boolean) => void;initial:Editing;canWrite:boolean;close:()=>void;saved:()=>void}) {
  const [initial,setInitial] = useState(original), [conflict,setConflict] = useState(false);
  const [text,setText]=useState(original.input.text || ''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [count,setCount]=useState(samples[initial.input.form]);
  const {key,locale,form}=initial.input;
  const required=[...new Set(initial.source.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g) || [])];
  const previewBundle: InterfaceBundle={...initial.bundle,overrides:[...initial.bundle.overrides.filter(o=>!(o.key===key&&o.locale===locale&&o.form===form)),{key,locale,form,text,source_text:initial.source}]};
  const parameters:Record<string,string|number>={count};
  for(const name of required) if(name!=='{count}') parameters[name.slice(1,-1)]=locale==='ar'?'مثال':'Example';
  let preview='';
  try {preview=formatInterfaceMessage(previewBundle,key,locale,parameters);} catch(e){preview=errorText(e);}
  const dirty = text !== (initial.input.text || '');
  const allowLeave = useUnsavedChanges(dirty);
  useEffect(() => {onEditorLock?.(dirty || busy);}, [dirty, busy, onEditorLock]);
  async function save(event: FormEvent, reset=false) {
    event.preventDefault();if(!canWrite)return;setBusy(true);setError('');
    try {await api.edit({...initial.input,text:reset?null:text});allowLeave();saved();}catch(e){setError(errorText(e));setConflict(e instanceof ApiError && e.status === 409);}finally{setBusy(false);}
  }
  return <form onSubmit={e=>void save(e)}><h3><code>{key}</code> · {locale} · {form}</h3><p>Built-in text: <bdi>{initial.source}</bdi></p><p>Required placeholders: {required.join(', ') || 'none'}</p>
    <div className="field"><label htmlFor="interface-phrase-text">Translation</label><textarea id="interface-phrase-text" rows={4} maxLength={4000} value={text} disabled={busy||conflict||!canWrite} lang={locale} dir={locale==='ar'?'rtl':'ltr'} onChange={e=>setText(e.target.value)}/></div>
    {initial.plural && <Field label="Preview quantity" type="number" min={0} step="any" value={count} onChange={e=>setCount(Number(e.target.value))}/>}
    <div className="translation-preview" aria-label="Phrase preview" lang={locale} dir={locale==='ar'?'rtl':'ltr'}>{preview}</div>
    {initial.plural && <p>The preview chooses the plural form for this quantity; only the {form} form is being edited.</p>}
    <Notice error>{error}</Notice>
    {conflict && <button type="button" className="secondary" disabled={busy} onClick={async () => {
      if (dirty && !window.confirm('Discard unsaved phrase changes and reload?')) return;
      setBusy(true);
      try {
        const bundle = await api.get();
        const message = bundle.messages.find(item => item.key === key);
        if (!message || message[locale][form] === undefined) throw new Error('This phrase is no longer available. Return to phrases.');
        const value = interfaceText(bundle,message,locale,form);
        setInitial({bundle,source:message[locale][form]!,plural:!!message.plural,input:{key,locale,form,text:value,expected_revision:bundle.revision,catalog_version:bundle.catalog_version}});
        setText(value);setConflict(false);setError('');
      } catch (cause) {setError(errorText(cause));}
      finally {setBusy(false);}
    }}>Reload latest version</button>}
    <div className="language-actions">{canWrite && <><button disabled={busy || conflict || !dirty}>{busy?'Saving…':'Save phrase'}</button><button className="secondary" type="button" disabled={busy || conflict} onClick={e=>void save(e,true)}>Restore built-in text</button></>}<button className="secondary" type="button" disabled={busy} onClick={() => {if (!dirty || window.confirm('Discard unsaved phrase changes?')) {allowLeave();close();}}}>Back to phrases</button></div>
  </form>;
}
