import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { deliveryFeeApi, type DeliveryFeeRule } from '@commerce/api-client';
import { Notice, useAction } from '@commerce/ui';
import { useUnsavedChanges } from './unsaved-changes';

// Reuse the customer address directory so admin choices have identical identifiers.
const directories = import.meta.glob('../../storefront/public/data/delivery/**/*.json', { import: 'default' });
const countries = [['EG','Egypt'],['SA','Saudi Arabia'],['KW','Kuwait'],['US','United States'],['NL','Netherlands'],['GB','United Kingdom']];
type Region = {code:string;name:string};
type City = {id:string;name:string;district?:string};
async function directory<T>(country:string, file:string):Promise<T> {
  const load=directories[`../../storefront/public/data/delivery/${country.toLowerCase()}/${file}.json`];
  if(!load) throw new Error('Location directory unavailable.');
  return await load() as T;
}
const empty = {area_id:null as string|null,country_code:'',state_code:'',city_id:'',location_name:'',source_id:null as string|null,amount:'',reason:''};
export function DeliveryFeeRules({canWrite,currency}:{canWrite:boolean;currency:string}) {
  const cache=useQueryClient(),action=useAction();
  const [form,setForm]=useState({...empty}),[kind,setKind]=useState('area'),[search,setSearch]=useState(''),[editing,setEditing]=useState(false);
  const patch=(v:Partial<typeof form>)=>setForm(f=>({...f,...v}));
  const rules=useQuery({queryKey:['delivery-fee-rules'],queryFn:deliveryFeeApi.rules});
  const choices=useQuery({queryKey:['delivery-fee-choices'],queryFn:deliveryFeeApi.choices});
  const regions=useQuery({queryKey:['fee-regions',form.country_code],enabled:!!form.country_code,queryFn:()=>directory<{states:Region[]}>(form.country_code,'index')});
  const cities=useQuery({queryKey:['fee-cities',form.country_code,form.state_code],enabled:!!form.country_code&&!!form.state_code,queryFn:()=>directory<City[]>(form.country_code,form.state_code)});
  useUnsavedChanges(editing);
  function edit(rule:DeliveryFeeRule) {
    if(editing&&!window.confirm('Discard unsaved fee changes?'))return;
    setForm({...rule,reason:''});setKind(rule.area_id?'area':'city');setEditing(true);
  }
  const cityOptions=cities.data?.filter(c=>c.id===form.city_id||`${c.name} ${c.district??''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).slice(0,200)??[];
  const selectedCity=cities.data?.find(c=>c.id===form.city_id);
  if(selectedCity&&!cityOptions.some(c=>c.id===selectedCity.id))cityOptions.unshift(selectedCity);
  return <section className="form-card"><h2>Location and warehouse fees</h2>
    <p>A warehouse override takes priority over the location fee, then the public default. At each level, mapped areas take priority over named locations. Orders use the highest applicable fee across their warehouses.</p>
    <Notice error>{rules.error?.message||choices.error?.message||regions.error?.message||cities.error?.message||action.error}</Notice><Notice>{action.message}</Notice>
    <div className="table-wrap"><table><thead><tr><th>Location</th><th>Type</th><th>Warehouse / source</th><th>Fee</th>{canWrite&&<th>Actions</th>}</tr></thead><tbody>{rules.data?.map(rule=><tr key={rule.id}><td>{rule.area_id?choices.data?.areas.find(a=>a.id===rule.area_id)?.name||rule.location_name:rule.location_name}</td><td>{rule.area_id?'Mapped area':'Named location'}</td><td>{rule.source_id?choices.data?.sources.find(s=>s.id===rule.source_id)?.name||'Warehouse':'Location default'}</td><td>{rule.amount} {currency}</td>{canWrite&&<td><button type="button" onClick={()=>edit(rule)}>Edit</button></td>}</tr>)}</tbody></table></div>
    {rules.isPending?<p>Loading fees…</p>:!rules.data?.length&&<p>No overrides. The public delivery fee applies.</p>}
    {canWrite&&<form onSubmit={e=>{e.preventDefault();void action.run(async()=>{await deliveryFeeApi.save({...form,amount:form.amount.trim()===''?null:form.amount});await cache.invalidateQueries({queryKey:['delivery-fee-rules']});setForm({...empty});setEditing(false);action.setMessage('Delivery fee rule saved.');});}}>
      <fieldset disabled={action.busy}><legend>{editing?'Edit fee':'Add a location or warehouse fee'}</legend>
      <div className="form-grid"><label className="field">Location type<select value={kind} onChange={e=>{setKind(e.target.value);setForm({...empty});setEditing(true);}}><option value="area">Mapped service area</option><option value="city">Named location</option></select></label>
      {kind==='area'?<label className="field">Service area<select required value={form.area_id??''} onChange={e=>{patch({area_id:e.target.value,location_name:choices.data?.areas.find(a=>a.id===e.target.value)?.name??''});setEditing(true);}}><option value="">Choose area</option>{choices.data?.areas.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>:<>
      <label className="field">Country<select required value={form.country_code} onChange={e=>{patch({country_code:e.target.value,state_code:'',city_id:'',location_name:''});setEditing(true);}}><option value="">Choose country</option>{countries.map(([code,name])=><option key={code} value={code}>{name}</option>)}</select></label>
      <label className="field">Region / governorate<select required value={form.state_code} onChange={e=>patch({state_code:e.target.value,city_id:'',location_name:''})}><option value="">Choose region</option>{regions.data?.states.map(r=><option key={r.code} value={r.code}>{r.name}</option>)}</select></label>
      <label className="field">Search city / district<input value={search} onChange={e=>setSearch(e.target.value)}/></label>
      <label className="field">City / district<select required value={form.city_id} onChange={e=>patch({city_id:e.target.value,location_name:[cities.data?.find(c=>c.id===e.target.value)?.name,regions.data?.states.find(r=>r.code===form.state_code)?.name,form.country_code].join(', ')})}><option value="">Choose location</option>{cityOptions.map(c=><option key={c.id} value={c.id}>{c.name}{c.district?` (${c.district})`:''}</option>)}</select><small>Search to narrow the first 200 matches.</small></label></>}
      <label className="field">Warehouse / source<select value={form.source_id??''} onChange={e=>{patch({source_id:e.target.value||null});setEditing(true);}}><option value="">Location default (all warehouses)</option>{choices.data?.sources.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
      <label className="field">Fee ({currency})<input type="number" min="0" max="1000000" step="0.01" value={form.amount} onChange={e=>{patch({amount:e.target.value});setEditing(true);}}/><small>Leave blank to remove this override and inherit. Enter 0 for free delivery.</small></label>
      <label className="field">Change reason<input required maxLength={300} value={form.reason} onChange={e=>{patch({reason:e.target.value});setEditing(true);}}/></label></div>
      <button disabled={action.busy}>Save fee rule</button> <button type="button" className="secondary" onClick={()=>{setForm({...empty});setKind('area');setEditing(false);}}>Cancel</button>
      </fieldset></form>}
  </section>;
}
