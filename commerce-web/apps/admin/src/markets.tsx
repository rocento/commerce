import { EntityIdLabel } from "./entity-id";
import { MarketPublication, RestoreMarketDefaults } from "./market-publication";
import { useState, useLayoutEffect, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError, entityInput, marketsApi, type MarketDraft, type MarketInput, type MarketOverride, type TranslationKind } from '@commerce/api-client';
import { Notice } from '@commerce/ui';
import { PageHeader } from './page-header';
import { useUnsavedChanges } from './unsaved-changes';
import type { EditorState } from './entity-translation';
import './editor-scope.css';
import './markets.css';
const countries = [['EG','Egypt'],['SA','Saudi Arabia'],['AE','United Arab Emirates'],['US','United States']];
const currencies = ['EGP','SAR','AED','USD'];
const message = 'Draft edits stay private until you review and publish them. This storefront supports one live market using its existing country, currency and checkout settings.';
export function MarketsSettings({ canWrite, canPublish = false, canReadCatalog = false }: { canWrite: boolean; canPublish?: boolean; canReadCatalog?: boolean }) {
  const [review,setReview]=useState<MarketDraft|null>(null);
  const query = useQuery({ queryKey: ['markets'], queryFn: marketsApi.list });
  const cache = useQueryClient();
  const [editing, setEditing] = useState<MarketInput | null>(null);
  const [saved, setSaved] = useState('');
  return <main className="markets-page"><PageHeader title="Markets" description="Prepare country-specific prices, catalog availability and languages." actions={!editing && !review && canWrite && query.data && <button onClick={() => { setSaved(''); setEditing({ id: crypto.randomUUID(), name:'',country:'EG',currency:'EGP',locales:[query.data.source_locale ?? query.data.locales[0]],default_locale:query.data.source_locale ?? query.data.locales[0],expected_revision:0 }); }}>Add market</button>}/>
    <p className="market-boundary">{message}</p><Notice>{saved}</Notice>
    {query.isPending && <p role="status">Loading markets…</p>}
    {query.error && <Notice error>{query.error.message}<button onClick={()=>void query.refetch()}>Retry</button></Notice>}
    {query.data && <><section className="form-card market-live"><h2>Current storefront</h2><p>{countries.find(([code])=>code===query.data.live.region)?.[1] ?? query.data.live.region} · {query.data.live.currency} <span className="market-badge">Live</span></p><p>{query.data.active?.release_id ? `${query.data.active.name} is published. Draft changes require another publication.` : "Using store-wide default catalog values."}</p>{canPublish&&query.data.active?.release_id&&<RestoreMarketDefaults revision={query.data.active.revision}/>}</section>
      {review ? <MarketPublication market={review} canPublish={canPublish} canReadCatalog={canReadCatalog} close={()=>setReview(null)}/> : editing ? <MarketForm key={editing.id} initial={editing} locales={query.data.locales} close={()=>{setEditing(null);void cache.invalidateQueries({queryKey:['markets']});}} saved={async item=>{setEditing(null);setSaved(`${item.name} saved as a draft.`);await cache.invalidateQueries({queryKey:['markets']});}}/> : <><div className="market-cards">{query.data.items.map(item=><section key={item.id} className="form-card"><div className="market-card-heading"><h2>{item.name}</h2><EntityIdLabel row={item}/><span className="market-badge">{query.data.active?.market_id===item.id?"Published · Editable draft":"Draft"}</span></div><p>{countries.find(([code])=>code===item.country)?.[1]} · {item.currency}</p><p>Languages: {item.locales.join(', ')} · Default: {item.default_locale}</p><p>Open a product, category or megamenu and select this market to prepare overrides.</p>{canWrite&&<button className="secondary" onClick={()=>{const {revision,...fields}=entityInput(item);setSaved('');setEditing({...fields,expected_revision:revision});}}>Edit {item.name}</button>} <button className="secondary" onClick={()=>setReview(item)}>Review {item.name}</button></section>)}</div>{!query.data.items.length&&<section className="form-card"><h2>Prepare your first market</h2><p>Add a country, choose its currency and reuse your existing content languages.</p></section>}</>}
      {!canWrite&&<p>View-only access. Market editing permission is required to make changes.</p>}
      <section className="form-card"><h2>One storefront, one live market</h2><p>The published market uses this storefront’s domain, delivery coverage, cash-on-delivery and geographic tax settings. Other-country checkout, simultaneous market switching and full language publication need separate setup. Prices are exact amounts; no automatic currency conversion is applied.</p></section>
    </>}
  </main>;
}
function MarketForm({ initial, locales, close, saved }: { initial: MarketInput; locales: string[]; close: ()=>void; saved: (item: MarketDraft)=>Promise<void> }) {
  const [form,setForm]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const dirty=JSON.stringify(form)!==JSON.stringify(initial);useUnsavedChanges(dirty);
  async function submit(event:FormEvent) { event.preventDefault();setBusy(true);setError('');try{await saved(await marketsApi.save(form));}catch(e){setError(e instanceof Error?e.message:'Unable to save market');}finally{setBusy(false);} }
  return <form className="form-card" onSubmit={submit}><h2>{initial.expected_revision?'Edit market':'New market'}</h2><fieldset disabled={busy}><legend className="sr-only">Market details</legend><div className="form-grid">
    <label className="field">Market name<input required maxLength={80} value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></label>
    <label className="field">Country<select value={form.country} onChange={e=>setForm({...form,country:e.target.value})}>{countries.map(([code,name])=><option key={code} value={code}>{name}</option>)}</select></label>
    <label className="field">Currency<select value={form.currency} onChange={e=>setForm({...form,currency:e.target.value})}>{currencies.map(code=><option key={code}>{code}</option>)}</select><small>Clear saved price overrides before changing currency.</small></label>
    <label className="field">Default language<select aria-label="Default language" value={form.default_locale} onChange={e=>setForm({...form,default_locale:e.target.value})}>{form.locales.map(locale=><option key={locale}>{locale}</option>)}</select></label>
  </div><fieldset><legend>Available languages</legend><div className="market-languages">{locales.map(locale=><label key={locale}><input type="checkbox" checked={form.locales.includes(locale)} disabled={locale===form.default_locale} onChange={e=>setForm({...form,locales:e.target.checked?[...form.locales,locale]:form.locales.filter(value=>value!==locale)})}/>{locale}</label>)}</div></fieldset><p>Add other languages in <Link to="/storefront/languages">Storefront languages</Link>. Translations are shared between markets.</p><div className="market-actions"><button>{busy?'Saving…':'Save draft market'}</button><button type="button" className="secondary" onClick={()=>{if(!dirty||window.confirm('Discard unsaved market changes?'))close();}}>Cancel</button></div></fieldset><Notice error>{error}</Notice></form>;
}
export function useEditorMarket(canRead:boolean, disabled:boolean) {
  const query=useQuery({queryKey:['markets'],queryFn:marketsApi.list,enabled:canRead});
  const [id,setId]=useState('');
  const market=query.data?.items.find(item=>item.id===id);
  const toolbar=canRead?<label className="editor-market-scope">Market<select aria-label="Market" value={id} disabled={disabled||!query.data} onChange={e=>setId(e.target.value)}><option value="">All markets · Default values</option>{query.data?.items.map(item=><option key={item.id} value={item.id}>{item.name} · Draft</option>)}</select>{disabled&&<small>Save current changes before switching markets.</small>}{query.error&&<small role="alert">Markets unavailable. <button type="button" onClick={()=>void query.refetch()}>Retry</button></small>}</label>:null;
  return {market,toolbar};
}
export function EntityMarketEditor({ market, kind, id, canWrite, onStateChange }: { market: MarketDraft; kind: TranslationKind; id:string; canWrite:boolean; onStateChange:(state:EditorState)=>void }) {
  const query=useQuery({queryKey:['market-entity',market.id,kind,id],queryFn:()=>marketsApi.entity(market.id,kind,id),gcTime:0,refetchOnWindowFocus:false});
  const [generation,setGeneration]=useState(0);
  if(query.isPending)return <p role="status">Loading market overrides…</p>;
  if(!query.data)return <Notice error>{query.error?.message}<button onClick={()=>void query.refetch()}>Retry</button></Notice>;
  return <MarketEntityForm key={generation} initial={query.data} market={market} kind={kind} id={id} canWrite={canWrite} onStateChange={onStateChange} reload={async()=>{const result=await query.refetch();if(result.error)throw result.error;setGeneration(value=>value+1);}}/>;
}
function MarketEntityForm({initial,market,kind,id,canWrite,onStateChange,reload}:{initial:MarketOverride;market:MarketDraft;kind:TranslationKind;id:string;canWrite:boolean;onStateChange:(state:EditorState)=>void;reload:()=>Promise<void>}) {
  const [snapshot,setSnapshot]=useState(initial.override),[available,setAvailable]=useState(initial.override.available),[price,setPrice]=useState(initial.override.price);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(''),[conflict,setConflict]=useState(false);
  const dirty=available!==snapshot.available||price!==snapshot.price;
  useUnsavedChanges(dirty);useLayoutEffect(()=>{onStateChange({dirty,busy});},[dirty,busy,onStateChange]);
  const inheritsPrice=initial.source.currency===initial.currency;
  return <section className="form-card market-entity"><h2>{market.name} · {initial.source.name}</h2><p className="market-boundary">Draft overrides only. The live storefront is unchanged. Content translations are shared; select All markets to edit text.</p><form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');setSaved('');try{const result=await marketsApi.saveEntity(market.id,kind,id,{available,price,currency:initial.currency,expected_revision:snapshot.revision});setSnapshot({available,price,revision:result.revision});setSaved('Draft market overrides saved.');}catch(cause){setError(cause instanceof Error?cause.message:'Unable to save');setConflict(cause instanceof ApiError&&cause.status===409);}finally{setBusy(false);}}}><fieldset disabled={!canWrite||busy||conflict}><legend className="sr-only">Market overrides</legend>
    <label className="field">Availability<select value={available===null?'inherit':String(available)} onChange={e=>setAvailable(e.target.value==='inherit'?null:e.target.value==='true')}><option value="inherit">Use default ({initial.source.available?'available':'unavailable'})</option><option value="true">Available in this market</option><option value="false">Unavailable in this market</option></select></label>
    {kind==='product'&&<><p>Default price: {initial.source.price} {initial.source.currency}</p><label className="market-inherit"><input type="checkbox" checked={price===null} onChange={e=>setPrice(e.target.checked?null:'')}/>Use default price</label>{price===null?<p>{inheritsPrice?`Inherits ${initial.source.price} ${initial.currency}.`:`A ${initial.currency} price is required before activation. The ${initial.source.currency} default cannot be used or converted automatically.`}</p>:<label className="field">Market price ({initial.currency})<input required inputMode="decimal" pattern="[0-9]{1,10}(\.[0-9]{1,2})?" value={price} onChange={e=>setPrice(e.target.value)}/></label>}</>}
    {kind!=='product'&&<p>This applies to this {kind==='navigation'?'menu':'category'} only. Product availability is managed separately.</p>}
    {canWrite&&<div className="market-actions"><button disabled={!dirty}>{busy?'Saving…':'Save market overrides'}</button>{dirty&&<button type="button" className="secondary" onClick={()=>{setAvailable(snapshot.available);setPrice(snapshot.price);setError('');}}>Discard market changes</button>}</div>}</fieldset></form><Notice>{saved}</Notice><Notice error>{error}</Notice>{!canWrite&&<p>View-only access. Both market and content editing permissions are required.</p>}{conflict&&<button className="secondary" disabled={busy} onClick={async()=>{if(!window.confirm('Discard this draft and load the latest market values?'))return;setBusy(true);try{await reload();}catch(e){setError(e instanceof Error?e.message:'Reload failed');setBusy(false);}}}>Reload latest values</button>}</section>;
}
