import { EntityIdHeading, EntityIdCell } from "./entity-id";
import { useUnsavedChanges } from './unsaved-changes';
import { DeliveryAreaOverview } from "./delivery-area-overview";
import { RowActions } from "./row-actions";
import { PageHeader } from "./page-header";
import { useLocalGrid } from "./local-grid";
import {useEffect,useRef,useState} from "react";
import {useQuery,useQueryClient} from "@tanstack/react-query";
import {deliveryApi,type DeliveryArea,type DeliveryPin} from "@commerce/api-client";
import {Notice,useAction} from "@commerce/ui";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./delivery-areas.css";
const empty={name:"",boundary:[] as DeliveryPin[],priority:0,is_active:true,stocks:[] as DeliveryArea["stocks"]};
function ZoneMap({points,onChange,disabled}:{points:DeliveryPin[];onChange:(points:DeliveryPin[])=>void;disabled:boolean}){
 const el=useRef<HTMLDivElement>(null),map=useRef<L.Map>(),layers=useRef<L.LayerGroup>(),change=useRef(onChange),current=useRef(points),locked=useRef(disabled);
 change.current=onChange;current.current=points;locked.current=disabled;
 useEffect(()=>{
  if(!el.current)return;
  const m=L.map(el.current).setView([30.0444,31.2357],11);map.current=m;
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).addTo(m);
  layers.current=L.layerGroup().addTo(m);
  if(current.current.length) m.fitBounds(L.latLngBounds(current.current.map(p=>[p.latitude,p.longitude] as L.LatLngTuple)),{maxZoom:14,padding:[30,30]});
  m.on("click",(e:L.LeafletMouseEvent)=>{if(!locked.current&&current.current.length<100)change.current([...current.current,{latitude:e.latlng.lat,longitude:e.latlng.lng}]);});
  return()=>{m.remove();map.current=undefined;layers.current=undefined;};
 },[]);
 useEffect(()=>{
  const group=layers.current;if(!group)return;group.clearLayers();
  const coords=points.map(p=>[p.latitude,p.longitude] as L.LatLngTuple);
  if(coords.length>=3)L.polygon(coords,{color:"#176b57",fillOpacity:.18,interactive:false}).addTo(group);
  else if(coords.length===2)L.polyline(coords,{color:"#176b57",interactive:false}).addTo(group);
  points.forEach((p,index)=>{
   const marker=L.marker([p.latitude,p.longitude],{draggable:!disabled,keyboard:!disabled,title:`Boundary point ${index+1}`,icon:L.divIcon({className:"zone-vertex",html:`<span>${index+1}</span>`,iconSize:[28,28],iconAnchor:[14,14]})}).addTo(group);
   marker.on("dragend",()=>{const next=marker.getLatLng();change.current(current.current.map((point,i)=>i===index?{latitude:next.lat,longitude:next.lng}:point));});
  });
 },[points,disabled]);
 return <div ref={el} className="zone-map" aria-label="Delivery boundary map. Click to add points; drag numbered points to adjust."/>;
}
export function DeliveryAreas({canWrite}:{canWrite:boolean}) {
 const cache=useQueryClient(),a=useAction();
 const [editorVersion,setEditorVersion]=useState(0);
 const [id,setId]=useState<string|null>(null),[editing,setEditing]=useState(false),[form,setForm]=useState({...empty}),[baseline,setBaseline]=useState(JSON.stringify(empty)),[status,setStatus]=useState('');
 // The complete domain endpoint includes stock links; grid rows do not.
 const areas=useQuery({queryKey:['delivery-areas'],queryFn:deliveryApi.areas});
 const stocks=useQuery({queryKey:['delivery-area-stocks'],queryFn:deliveryApi.stocks});
 const grid=useLocalGrid({name:'delivery-areas',rows:areas.data?.filter(x=>!status||String(x.is_active)===status),searchText:x=>x.name,sorts:{name:x=>x.name,priority:x=>x.priority},initialSort:'priority',scope:status,busy:areas.isFetching,error:areas.error?.message,refresh:()=>void areas.refetch()});
 useEffect(()=>{if(editing)document.querySelector('.delivery-area-editor')?.scrollIntoView({block:'start'});},[editing,editorVersion]);
 const dirty=editing&&JSON.stringify(form)!==baseline;
 useUnsavedChanges(dirty);
 const patch=(value:Partial<typeof form>)=>setForm(f=>({...f,...value}));
 function open(area?:DeliveryArea,duplicate=false) {
  if(dirty&&!window.confirm('Discard unsaved delivery area changes?'))return;
  const next=area?{name:duplicate?`${area.name.slice(0,90)} copy`:area.name,boundary:area.boundary??[],priority:area.priority,is_active:duplicate?false:area.is_active,stocks:area.stocks}:{...empty,boundary:[],stocks:[]};
  setId(duplicate?null:area?.id??null);setForm(next);setBaseline(JSON.stringify(duplicate?empty:next));setEditorVersion(v=>v+1);setEditing(true);a.setMessage('');
 }
 const issues=[!form.name.trim()?'Enter a delivery area name.':'',form.boundary.length<3?'Add at least three boundary points.':'',form.is_active&&!form.stocks.length?'Assign at least one stock before activating this delivery area.':''].filter(Boolean);
 return <main className="catalog-admin"><PageHeader title={<>Service areas</>} description={<>Manage delivery coverage, availability and fulfillment stock assignments. Lower priority numbers win when areas overlap.</>}/>
 <div className="delivery-area-summary"><span><strong>{areas.data?.length??'—'}</strong> Service areas</span><span><strong>{areas.data?.filter(x=>x.is_active).length??'—'}</strong> Active</span><span><strong>{areas.data?.filter(x=>!x.is_active).length??'—'}</strong> Inactive</span>{canWrite&&<button onClick={()=>open()}>New delivery area</button>}</div>
 <Notice error>{areas.error?.message||stocks.error?.message||a.error}</Notice><Notice>{a.message}</Notice>
 {areas.data && <DeliveryAreaOverview areas={areas.data} stocks={stocks.data??[]} canWrite={canWrite} onOpen={open}/>}
 {grid.renderControls({filters:<label className="field">Status<select value={status} onChange={e=>setStatus(e.target.value)}><option value="">All delivery areas</option><option value="true">Active</option><option value="false">Inactive</option></select></label>,chips:status?[{label:status==='true'?'Active':'Inactive',remove:()=>setStatus('')}]:[],clearFilters:()=>setStatus('')})}
 {areas.isPending?<p role="status">Loading delivery areas…</p>:<div className="table-wrap"><table><thead><tr><EntityIdHeading/><th>Delivery area</th><th>Status</th><th>Priority</th><th>Boundary</th><th>Assigned stocks</th><th>Actions</th></tr></thead><tbody>{grid.data.map(area=><tr key={area.id}><EntityIdCell row={area}/><td>{area.name}</td><td><span className="badge">{area.is_active?'Active':'Inactive'}</span></td><td>{area.priority}</td><td>{area.boundary?`${area.boundary.length} points`:'Legacy circle'}</td><td>{area.stocks.length?area.stocks.map(link=>stocks.data?.find(s=>s.id===link.stock_id)?.name||'Assigned stock').join(', '):'None assigned'}</td><td><RowActions label={area.name} items={[{label:canWrite?"Edit":"View",onSelect:()=>open(area)},...(canWrite?[{label:"Duplicate",onSelect:()=>open(area,true)}]:[])]}/></td></tr>)}</tbody></table>{!areas.error&&!grid.data.length&&<p>No delivery areas match these filters.</p>}</div>}
 {editing&&<section className="form-card delivery-area-editor"><div className="delivery-area-editor-heading"><div><h2>{id?form.name||'Edit delivery area':'New delivery area'}</h2><p>{dirty?'Unsaved changes':'Draw a boundary, assign stocks, and save.'}</p></div><button className="secondary" disabled={a.busy} onClick={()=>{if(!dirty||window.confirm('Discard unsaved delivery area changes?'))setEditing(false);}}>Close editor</button></div>
 <form onSubmit={e=>{e.preventDefault();if(issues.length)return;void a.run(async()=>{const savedForm={...form,name:form.name.trim()};const saved=await deliveryApi.save(id,savedForm);setId(saved.id);setForm(savedForm);setBaseline(JSON.stringify(savedForm));await cache.invalidateQueries({queryKey:['delivery-areas']});a.setMessage('Delivery area saved. Coverage and stock assignments are updated.');});}}><fieldset disabled={!canWrite||a.busy}>
 <div className="form-grid"><label className="field">Delivery area name<input required maxLength={100} value={form.name} onChange={e=>patch({name:e.target.value})}/></label><label className="field">Delivery area priority<input required type="number" step="1" min="-1000000" max="1000000" value={form.priority} onChange={e=>patch({priority:Number(e.target.value)})}/></label></div>
 <label><input type="checkbox" checked={form.is_active} onChange={e=>patch({is_active:e.target.checked})}/> Active for delivery</label><p className="help">Inactive areas are excluded from delivery matching. Existing orders retain their delivery information.</p>
 {id&&!areas.data?.find(x=>x.id===id)?.boundary&&<p className="help">This area uses a legacy circular boundary. Draw a polygon of at least 3 points before saving.</p>}
 <h3>Delivery boundary</h3><p>Click the map to add points. Drag numbered points to adjust them, or enter coordinates below.</p>
 <ZoneMap key={editorVersion} points={form.boundary} disabled={!canWrite||a.busy} onChange={boundary=>patch({boundary})}/>
 <div className="zone-drawing-tools"><span role="status">{form.boundary.length} / 100 points · {form.boundary.length<3?'Add at least 3 points':'Boundary closes automatically'}</span><button type="button" className="secondary" disabled={!form.boundary.length} onClick={()=>patch({boundary:form.boundary.slice(0,-1)})}>Undo last point</button><button type="button" className="secondary" disabled={!form.boundary.length} onClick={()=>patch({boundary:[]})}>Clear boundary</button></div>
 <details className="zone-coordinates"><summary>Edit boundary coordinates</summary>{form.boundary.map((point,index)=><div className="zone-coordinate-row" key={index}><strong>Point {index+1}</strong>{(['latitude','longitude'] as const).map(key=><label className="field" key={key}>{key==='latitude'?'Latitude':'Longitude'}<input aria-label={`Point ${index+1} ${key}`} required type="number" step="any" min={key==='latitude'?-90:-180} max={key==='latitude'?90:180} value={point[key]} onChange={e=>patch({boundary:form.boundary.map((p,i)=>i===index?{...p,[key]:Number(e.target.value)}:p)})}/></label>)}<button type="button" className="secondary" onClick={()=>patch({boundary:form.boundary.filter((_,i)=>i!==index)})}>Remove point {index+1}</button></div>)}<button type="button" className="secondary" disabled={form.boundary.length>=100} onClick={()=>patch({boundary:[...form.boundary,{latitude:30.0444,longitude:31.2357}]})}>Add coordinate point</button></details>
 <h3>Stocks serving this delivery area</h3><p className="help">Choose the inventory pools that can fulfill orders here. Lower stock priority numbers are tried first.</p>
 {stocks.isPending&&<p role="status">Loading stocks…</p>}{stocks.data?.length===0&&<p>Create a stock under Fulfillment → Stocks before activating this delivery area.</p>}
 {stocks.data?.map(stock=>{const link=form.stocks.find(x=>x.stock_id===stock.id);return <div className="delivery-stock-row" key={stock.id}><label><input type="checkbox" checked={!!link} onChange={e=>patch({stocks:e.target.checked?[...form.stocks,{stock_id:stock.id,priority:0}]:form.stocks.filter(x=>x.stock_id!==stock.id)})}/>{stock.name}</label>{link&&<label className="field">Fulfillment priority<input aria-label={`${stock.name} priority`} type="number" min="-1000000" max="1000000" step="1" required value={link.priority} onChange={e=>patch({stocks:form.stocks.map(x=>x.stock_id===stock.id?{...x,priority:Number(e.target.value)}:x)})}/></label>}</div>;})}
 {issues.length>0&&<ul className="help">{issues.map(issue=><li key={issue}>{issue}</li>)}</ul>}<button type="submit" disabled={!!issues.length||stocks.isPending||!!stocks.error||!dirty}>{a.busy?'Saving…':id?'Save delivery area':'Create delivery area'}</button>
 </fieldset></form></section>}
 </main>;
}
