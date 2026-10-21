import { MediaPicker } from '../../../packages/ui/src/media-picker';
import { catalogApi, contentApi, discoverabilityApi, mediaUrl } from '@commerce/api-client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Field, Notice } from '@commerce/ui';
import { DiscoveryResourcePicker, type ResourceKind } from './discovery-resource-picker';
const pageNames: Record<string,string> = {home:'Homepage',product:'Product pages',category:'Category pages',content:'Content pages'};
type Text = { title: string; description: string };
type Configuration = { templates: Record<string, Text>; overrides: Record<string, Text>; social_image: string | null };
type Settings = { revision: number; configuration: Configuration };
type Preview = { status: number; canonical: { html: string } | null; robots: string; metadata: { title: string; description: string; image: string | null; warnings: string[] }; images: Record<string, { alt: string; width: number; height: number }> };
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/v1/admin/discovery/metadata${path}`, { method, credentials: 'include', cache: 'no-store', headers: body ? { 'content-type': 'application/json', 'X-Commerce-Request': '1' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `Request failed (${response.status})`);
  return value as T;
}
export function MetadataSettings({ canWrite }: { canWrite: boolean }) {
  const query = useQuery({ queryKey: ['publication-metadata'], queryFn: () => request<Settings>('') });
  return query.data ? <Editor initial={query.data} canWrite={canWrite} /> : <Notice error={!!query.error}>{query.error?.message || 'Loading metadata settings…'}</Notice>;
}
function Editor({ initial, canWrite }: { initial: Settings; canWrite: boolean }) {
  const cache = useQueryClient();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [labels, setLabels] = useState<Record<string,string>>({});
  const [settings, setSettings] = useState(initial);
  const [path, setPath] = useState('/');
  const [kind, setKind] = useState<ResourceKind>('product');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const media = useQuery({ queryKey: ['publication-metadata-media'], queryFn: catalogApi.mediaList });
  const identity = useQuery({queryKey:['discoverability-settings'],queryFn:discoverabilityApi.get});
  useEffect(() => { setPreview(null); }, [identity.data?.revision]);
  const config = settings.configuration;
  const change = (configuration: Configuration) => { setSettings({ ...settings, configuration }); setPreview(null); setNotice(''); };
  const fields = (group: 'templates' | 'overrides', key: string) => <div className="form-grid">{(['title', 'description'] as const).map(field => <Field key={field} label={field === 'title' ? 'Page title' : 'Search description'} value={config[group][key]?.[field] || ''} onChange={event => change({ ...config, [group]: { ...config[group], [key]: { ...(config[group][key] || { title: '', description: '' }), [field]: event.target.value } } })} />)}</div>;
  async function run(save: boolean) {
    if (busy || (save && !canWrite)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (save) { const saved = await request<Settings>('', 'PUT', { expected_revision: settings.revision, configuration: config }); setSettings(saved); cache.setQueryData(['publication-metadata'], saved); setPreview(null); await cache.invalidateQueries({queryKey:['discovery-health']}); setNotice('Search appearance saved.'); }
      else setPreview(await request<Preview>('/preview', 'POST', { path, page: 1, configuration: config }));
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to resolve metadata'); } finally { setBusy(false); }
  }
  return <section className="form-card visibility-card"><h2>Search appearance</h2><p className="visibility-description">Manage page titles, descriptions, and the image used when your store is shared.</p>
    <fieldset disabled={!canWrite || busy}><legend className="visibility-sr-only">Search appearance settings</legend>
      <details className="visibility-details" open><summary>Page title &amp; description templates</summary><p className="help">Blank values use your catalog, content, and saved store details.</p>
      {Object.entries(pageNames).map(([type,name]) => <details className="visibility-template" key={type} open={type==='home'}><summary>{name}</summary>{fields('templates', type)}</details>)}
      <details className="visibility-details"><summary>Available template fields</summary><p className="help">{'{page_name}, {product_name}, {category_name}, {content_title}, {merchant_name}, {description}, {default_description}'}</p><p className="help">Titles around 60 characters and descriptions around 160 characters are guidance, not limits.</p></details></details>
      <details className="visibility-details"><summary>Social sharing image</summary>
      <MediaPicker label="Default social image" value={config.social_image || ''} media={media.data || []} imageUrl={mediaUrl} loading={media.isPending} onChange={value => change({ ...config, social_image: value || null })} /><Notice error>{media.error?.message}</Notice><button type="button" disabled={!config.social_image} onClick={async () => { setBusy(true); setError(''); try { const response = await fetch(`/api/v1/admin/catalog/media/${config.social_image}/publication`, { method: 'POST', credentials: 'include', headers: { 'X-Commerce-Request': '1' } }); if (!response.ok) throw new Error('Image processing failed. Catalog write permission and a valid image are required.'); setNotice('Image dimensions and responsive versions prepared. Save search appearance to publish this selection.'); } catch (e) { setError(e instanceof Error ? e.message : 'Unable to process image'); } finally { setBusy(false); } }}>Prepare image for sharing</button><p>Choose a processed image from Catalog → Media. Saving this selection publishes that image for social sharing.</p></details>
      <details className="visibility-details" onToggle={event=>setPickerOpen(event.currentTarget.open)}><summary>Individual page overrides ({Object.keys(config.overrides).length})</summary><p className="help">Choose a page to customize its title and description.</p>
      <label className="field">Page type<select value={kind} onChange={e => setKind(e.target.value as ResourceKind)}><option value="product">Product</option><option value="category">Category</option><option value="content">Content page</option></select></label>
      {pickerOpen && <DiscoveryResourcePicker key={kind} kind={kind} onSelect={(id,label)=>{const key=`${kind}:${id}`;setLabels(values=>({...values,[key]:label}));change({...config,overrides:{...config.overrides,[key]:config.overrides[key]||{title:'',description:''}}});}}/>}
      {Object.keys(config.overrides).map(key => <section className="visibility-policy" key={key}><h3><OverrideName resourceKey={key} label={labels[key]} enabled={pickerOpen}/></h3>{fields('overrides', key)}<button type="button" className="secondary" onClick={() => { const overrides = { ...config.overrides }; delete overrides[key]; change({ ...config, overrides }); }}>Remove override</button><details className="visibility-details"><summary>Page reference</summary><code>{key}</code></details></section>)}</details>
<div className="visibility-savebar"><span className="help">Changes apply to public page metadata.</span><button type="button" onClick={() => void run(true)}>{busy?'Working…':'Save search appearance'}</button></div>
    </fieldset><section className="visibility-form-section"><h3>Search result preview</h3><p className="help">Preview current appearance settings with saved store details. Save changes to Store details first.</p>
    <Field label="Page path" disabled={busy} value={path} onChange={e => { setPath(e.target.value); setPreview(null); }} placeholder="/products/apples" /><button type="button" className="secondary" disabled={busy || !path.startsWith('/')} onClick={() => void run(false)}>Preview page</button>
    <Notice error>{error}</Notice><Notice>{notice}</Notice>{preview && <section aria-label="Search result preview"><div className="visibility-search-preview"><span className="help">{preview.canonical?.html || path}</span><h3>{preview.metadata.title}</h3>{preview.metadata.image && preview.images[preview.metadata.image] && <img src={mediaUrl(preview.metadata.image)} alt={preview.images[preview.metadata.image].alt} width={preview.images[preview.metadata.image].width} height={preview.images[preview.metadata.image].height} style={{ maxWidth: 'min(320px,100%)', height: 'auto' }} />}<p>{preview.metadata.description}</p></div><p className="help">Search engines may display different text.</p><details className="visibility-details"><summary>Preview technical details</summary><dl className="visibility-facts"><dt>Canonical</dt><dd>{preview.canonical?.html || 'Unavailable'}</dd><dt>Robots</dt><dd>{preview.robots}</dd><dt>HTTP status</dt><dd>{preview.status}</dd><dt>Social image</dt><dd>{preview.metadata.image ? preview.images[preview.metadata.image]?.alt || preview.metadata.image : 'No image available'}</dd></dl></details>{preview.metadata.warnings.map(w => <p key={w}>{w}</p>)}</section>}
  </section></section>;
}

function OverrideName({resourceKey,label,enabled}:{resourceKey:string;label?:string;enabled:boolean}) {
 const [kind,id]=resourceKey.split(':');
 const query=useQuery({queryKey:['discovery-resource-name',kind,id],enabled:enabled&&!label,retry:false,queryFn:async()=>{
  if(kind==='product') return (await catalogApi.adminProduct(id)).name;
  if(kind==='category') return (await catalogApi.adminCategories()).find(row=>row.id===id)?.name ?? null;
  if(kind==='content') return (await contentApi.detail(id)).document.key;
  return null;
 }});
 return <>{label||query.data||(query.isFetching?'Loading page name…':`${kind==='content'?'Content':kind==='category'?'Category':'Product'} page`)}</>;
}
