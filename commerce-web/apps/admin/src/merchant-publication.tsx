import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Field, Notice } from '@commerce/ui';
import { catalogApi, mediaUrl } from '@commerce/api-client';
import { MediaPicker } from '../../../packages/ui/src/media-picker';
type Page = { document_id: string; revision_id: string; purpose: string; locale: string; effective_date: string | null; comparison_products: string[] };
type Configuration = { published: boolean; legal_name: string; description: string; logo_id: string | null; contact_published: boolean; email: string; telephone: string; locations_published: boolean; country: string; region: string; locations: string[]; delivery_areas: string[]; social_profiles: string[]; pages: Page[] };
type Status = { revision: number; locale: string; configuration: Configuration; warnings: string[]; pages: { document_id: string; purpose: string; status: string; reason: string }[]; documents: { id: string; key: string; version: number; current_revision: string | null; state: string }[]; industry: string | null; coverage: { label: string; active_products: number; with_value: number }[] };
type SaveProfile = { expected_revision: number; configuration: Configuration };
function request(): Promise<Status>;
function request(body: SaveProfile): Promise<{ revision: number }>;
async function request(body?: SaveProfile): Promise<Status | { revision: number }> {
 const r = await fetch('/api/v1/admin/discovery/entity', { method: body ? 'PUT' : 'GET', credentials: 'include', cache: 'no-store', headers: body ? { 'Content-Type': 'application/json', 'X-Commerce-Request': '1' } : undefined, body: body ? JSON.stringify(body) : undefined });
 if (!r.ok) throw new Error(r.status === 409 ? 'The profile changed. Reload before saving.' : `Unable to load or save public merchant profile (${r.status})`);
 return r.json();
}
export function useMerchantPublication() { return useQuery({ queryKey: ['merchant-publication'], queryFn: () => request(), retry: false }); }
export function MerchantPublication({ canWrite }: { canWrite: boolean }) {
 const q = useMerchantPublication();
 return q.data ? <><Notice error>{q.error?.message}</Notice><Editor initial={q.data} canWrite={canWrite} reload={() => q.refetch()} /></> : <Notice error={!!q.error}>{q.error?.message || 'Loading business profile…'}</Notice>;
}
function Editor({ initial, canWrite, reload }: { initial: Status; canWrite: boolean; reload: () => unknown }) {
 const cache = useQueryClient();
 const [revision, setRevision] = useState(initial.revision);
 const [c, set] = useState(initial.configuration), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
 const media = useQuery({ queryKey: ['public-merchant-media'], queryFn: catalogApi.mediaList });
 const change = <K extends keyof Configuration>(key: K, value: Configuration[K]) => { set({ ...c, [key]: value }); setNotice(''); };
 async function save() {
  if (!canWrite || busy) return;
  setBusy(true); setError(''); setNotice('');
  try {
   const saved = await request({ expected_revision: revision, configuration: c });
   setRevision(saved.revision);
   await cache.invalidateQueries({ queryKey: ['discovery-health'] }); await reload(); setNotice('Business profile saved.');
  } catch (e) { setError(e instanceof Error ? e.message : 'Unable to save business profile.'); }
  finally { setBusy(false); }
 }
 const field = (key: 'legal_name' | 'description' | 'email' | 'telephone' | 'country' | 'region', label: string) => <Field label={label} maxLength={1000} value={c[key]} onChange={e => change(key, e.target.value)} />;
 const lines = (key: 'locations' | 'delivery_areas' | 'social_profiles', label: string) => <label className="field">{label}<textarea value={c[key].join('\n')} onChange={e => change(key, e.target.value.split('\n'))} onBlur={() => change(key, c[key].map(v => v.trim()).filter(Boolean))} /></label>;
 return <section className="form-card visibility-card"><h2>Public business information</h2><p className="visibility-description">Manage the approved business information shared across your public pages, search, and AI.</p><p className="help">Store name and language come from <Link to="/system/configuration/discoverability/seo">SEO settings</Link>.</p>
 {initial.warnings.length > 0 && <details className="visibility-details"><summary>{initial.warnings.length} {initial.warnings.length === 1 ? 'item' : 'items'} to review</summary><ul>{initial.warnings.map(w => <li key={w}>{w}</li>)}</ul></details>}<Notice error>{error}</Notice><Notice>{notice}</Notice>
 <fieldset disabled={!canWrite || busy}><legend className="visibility-sr-only">Business profile</legend><label className="check"><input type="checkbox" checked={c.published} onChange={e => change('published', e.target.checked)} />Publish this business profile</label>
 <div className="form-grid">{field('legal_name', 'Legal business name')}{field('description', 'Business description')}</div>
 <MediaPicker label="Public business logo" value={c.logo_id || ''} onChange={id => change('logo_id', id || null)} media={media.data || []} imageUrl={mediaUrl} />
 <details className="visibility-details"><summary>Contact details &amp; locations</summary><div className="form-grid">{field('country', 'Country')}{field('region', 'Region')}
 {field('email', 'Public customer-service email')}{field('telephone', 'Public customer-service telephone')}</div>
 <label className="check"><input type="checkbox" checked={c.contact_published} onChange={e => change('contact_published', e.target.checked)} />Show these contact details publicly</label>
 {lines('locations', 'Public business locations — one per line')}<label className="check"><input type="checkbox" checked={c.locations_published} onChange={e => change('locations_published', e.target.checked)} />Show these locations publicly</label>
 {lines('delivery_areas', 'Merchant-approved delivery areas — one per line')}{lines('social_profiles', 'Official social profile URLs — one per line')}</details>
 <section className="visibility-form-section"><h3>Policies &amp; guides</h3><p className="help"><Link to="/storefront/pages">Write and publish content</Link>, then approve the version to share publicly. Updated versions need a new approval.</p>{c.pages.map((page, index) => <section className="visibility-policy" key={page.document_id}><strong>{initial.documents.find(d => d.id === page.document_id)?.key || 'Unavailable page'}</strong><p className="help">{initial.pages.find(p => p.document_id === page.document_id)?.reason || 'New approval — save to apply.'}</p>
 <label>Purpose<select value={page.purpose} onChange={e => change('pages', c.pages.map((p, i) => i === index ? { ...p, purpose: e.target.value, comparison_products: [] } : p))}>{['shipping','returns','warranty','payment','buying-guide','category-guide','sizing-guide','materials-guide','ingredients-guide','comparison','faq','care'].map(v => <option key={v}>{v}</option>)}</select></label>
 <Field label="Content locale" value={page.locale} onChange={e => change('pages', c.pages.map((p, i) => i === index ? { ...p, locale: e.target.value } : p))} />
 <Field label="Policy effective date" type="date" value={page.effective_date || ''} onChange={e => change('pages', c.pages.map((p, i) => i === index ? { ...p, effective_date: e.target.value || null } : p))} />
 {page.purpose === 'comparison' && <ComparisonPicker value={page.comparison_products} onChange={ids => change('pages', c.pages.map((p, i) => i === index ? { ...p, comparison_products: ids } : p))} />}
 <button type="button" disabled={!initial.documents.find(d => d.id === page.document_id)?.current_revision} onClick={() => change('pages', c.pages.map((p, i) => i === index ? { ...p, revision_id: initial.documents.find(d => d.id === page.document_id)!.current_revision! } : p))}>Use latest published version</button>
 <button type="button" onClick={() => change('pages', c.pages.filter((_, i) => i !== index))}>Remove from profile</button></section>)}
 <label>Add a published page<select value="" onChange={e => { const d = initial.documents.find(d => d.id === e.target.value); if (d?.current_revision) change('pages', [...c.pages, { document_id: d.id, revision_id: d.current_revision, purpose: 'buying-guide', locale: initial.locale, effective_date: null, comparison_products: [] }]); }}><option value="">Select a page</option>{initial.documents.filter(d => d.current_revision && !c.pages.some(p => p.document_id === d.id)).map(d => <option value={d.id} key={d.id}>{d.key}</option>)}</select></label>
 </section><div className="visibility-savebar"><span className="help">Only explicitly approved information is published.</span><button type="button" onClick={() => void save()}>{busy ? 'Saving…' : 'Save business profile'}</button></div></fieldset>
 <details className="visibility-details"><summary>Content publication details</summary><ul>{initial.documents.map(d => <li key={d.id}>{d.key} — {d.state} · version {d.version}</li>)}</ul></details>
 <details className="visibility-details"><summary>Product information coverage</summary><p>Industry schema: {initial.industry || 'No industry profile selected'}. Counts sample up to 1,000 active products in ID order and show eligible public values for visible or variant attributes; they do not certify accuracy.</p><div className="table-wrap"><table><thead><tr><th>Attribute label</th><th>With value</th><th>Sampled active products</th></tr></thead><tbody>{initial.coverage.map(r => <tr key={r.label}><td>{r.label}</td><td>{r.with_value}</td><td>{r.active_products}</td></tr>)}</tbody></table></div></details>
 </section>;
}

function ComparisonPicker({ value, onChange }: { value: string[]; onChange: (ids: string[]) => void }) {
 const [offset, setOffset] = useState(0);
 const q = useQuery({ queryKey: ['comparison-products', offset], queryFn: () => catalogApi.products(offset) });
 return <section><h4>Choose 2–6 catalog products</h4><p>{value.length} selected. Comparisons use current public facts.</p><Notice error>{q.error?.message}</Notice>{q.data?.filter(p => p.active).map(p => <label className="check" key={p.id}><input type="checkbox" checked={value.includes(p.id)} disabled={!value.includes(p.id) && value.length >= 6} onChange={e => onChange(e.target.checked ? [...value, p.id] : value.filter(id => id !== p.id))} />{p.name} — {p.sku}</label>)}<button type="button" disabled={offset === 0 || q.isFetching} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous products</button><button type="button" disabled={!q.data || q.data.length < 50 || q.isFetching} onClick={() => setOffset(offset + 50)}>Next products</button><button type="button" onClick={() => onChange([])}>Clear selection</button></section>;
}
