import { useEffect, useState } from 'react';
import { mobileApi } from '@commerce/api-client';
import { MobileCategoryPicker } from './mobile-category-picker';
export function MobileFeedPicker({merchant,value,change}: {merchant:string;value:string;change:(value:string)=>void}) {
  const [feeds,setFeeds]=useState<{id:string;name:string}[]>([]);
  const [error,setError]=useState(false);
  useEffect(()=>{const controller=new AbortController();setFeeds([]);setError(false);mobileApi.catalog(merchant,'en',undefined,controller.signal).then(c=>setFeeds(c.feeds||[])).catch(()=>{if(!controller.signal.aborted)setError(true);});return()=>controller.abort();},[merchant]);
  return <><label className="ms-field">Product source<select value={value.startsWith('demo-feed-')?value:'category'} onChange={e=>change(e.target.value==='category'?'':e.target.value)}><option value="category">Catalog category</option>{value.startsWith('demo-feed-')&&!feeds.some(f=>f.id===value)&&<option value={value}>Saved demo section</option>}{feeds.map(f=><option key={f.id} value={f.id}>{f.name} · Demo home feed</option>)}</select></label>{error&&<p role="status">Demo feeds could not be loaded. Reopen this section to retry.</p>}{value.startsWith('demo-feed-')?<p className="ms-help">Uses the same query, collection, and ranking as this section on the connected demo.</p>:<MobileCategoryPicker merchant={merchant} label="Product category" values={value?[value]:[]} change={ids=>change(ids[0])}/>}</>;
}
