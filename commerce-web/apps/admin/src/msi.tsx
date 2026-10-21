import { EntityIdHeading, EntityIdCell, EntityIdLabel } from "./entity-id";
import { ReasonField, reasonOptions } from "./reason-field";
import { useUnsavedChanges } from './unsaved-changes';
import { RowActions } from "./row-actions";
import { PageHeader } from "./page-header";
import { LocationPickup } from "./location-pickup";
import "./location-pickup.css";
import { SourceMap } from "./source-map";
import { useGrid } from "./grids";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { adminApi, msiApi, type InventorySource, type InventorySourceInput, type StockPoolInput, type SourceItem } from "@commerce/api-client";
import { Field, Notice, useAction } from "@commerce/ui";
import { deductionOrder, setSourceAssignment, setSourcePriority } from "./msi-logic";
const emptySource:InventorySourceInput={code:"",name:"",is_enabled:true,address:"",latitude:null,longitude:null,contact_name:"",contact_phone:"",priority:0};
export function Sources({canWrite}:{canWrite:boolean}) {
 const q=useGrid("sources",["inventory","sources"]);
 const cache=useQueryClient();
 return <main className="catalog-admin"><PageHeader title={<>Locations</>} description={<>Manage retail branches, warehouses, and other physical stock locations.</>} actions={<>{canWrite&&<Link className="primary-link" to="/catalog/sources/new">Add inventory location</Link>}</>} />{q.controls}<Notice error>{q.error?.message}</Notice>
 <div className="table-wrap"><table><thead><tr><EntityIdHeading/><th>Inventory location</th><th>Code</th><th>Status</th><th>Address</th><th>Actions</th></tr></thead><tbody>{q.data?.map(s=><tr key={s.id}><EntityIdCell row={s}/><td>{s.name}</td><td>{s.code}</td><td>{s.is_enabled?"Enabled":"Disabled"}</td><td>{s.address}</td><td><RowActions label={s.name} items={[{label:canWrite?"Edit":"View",to:`/catalog/sources/${s.id}`},...(canWrite?[{label:"Delete",destructive:true,confirm:"Delete this inventory location? Locations in use may not be deleted.",onSelect:async()=>{await msiApi.deleteSource(s.id);await cache.invalidateQueries({queryKey:["inventory"]});}}]:[])]}/></td></tr>)}</tbody></table></div>
 </main>;
}

type SourcePermissions = {canWrite:boolean;canReadPickup?:boolean;canManagePickup?:boolean};
export function SourceEditor({canWrite,canReadPickup=false,canManagePickup=false}:SourcePermissions) {
 const {id}=useParams();
 const editing=!!id&&id!=="new";
 const sources=useQuery({queryKey:["inventory","sources"],queryFn:msiApi.sources,enabled:editing});
 const existing=sources.data?.find(source=>source.id===id);
 return <main className="catalog-admin location-editor">
  <Link to="/catalog/sources" className="back-link">Back to inventory locations</Link>
  <PageHeader title={<>{editing?(canWrite?"Edit inventory location":"Inventory location"):"New inventory location"}</>} description={<>Manage location details, contact information and pickup settings for each connected store.</>}/><EntityIdLabel row={existing}/>
  {!canWrite&&!editing?<Notice error>You do not have permission to edit inventory locations.</Notice>
   :editing&&sources.isPending?<p role="status">Loading inventory location…</p>
   :editing&&sources.isError&&!sources.data?<><Notice error>{sources.error.message}</Notice><button type="button" onClick={()=>void sources.refetch()}>Retry</button></>
   :editing&&!existing?<Notice error>Inventory location not found.</Notice>
   :<SourceForm key={existing?.id??"new"} source={existing} canWrite={canWrite} canReadPickup={canReadPickup} canManagePickup={canManagePickup}/>}
 </main>;
}

function SourceForm({source,canWrite,canReadPickup,canManagePickup}:{source?:InventorySource}&SourcePermissions) {
 const [form,setForm]=useState<InventorySourceInput>(()=>source?{
  code:source.code,name:source.name,is_enabled:source.is_enabled,address:source.address,
  latitude:source.latitude,longitude:source.longitude,contact_name:source.contact_name,
  contact_phone:source.contact_phone,priority:source.priority,
 }:emptySource);
 const a=useAction(),cache=useQueryClient(),navigate=useNavigate();
 const [initial,setInitial] = useState(() => JSON.stringify(form));
 const [pickupDirty,setPickupDirty] = useState(false);
 const allowLeave = useUnsavedChanges(JSON.stringify(form) !== initial || pickupDirty || a.busy);
 const update=<K extends keyof InventorySourceInput>(key:K,value:InventorySourceInput[K])=>setForm({...form,[key]:value});
 return <><form className="form-card" onSubmit={e=>{e.preventDefault();if(!canWrite||a.busy)return;void a.run(async()=>{const saved=await msiApi.saveSource(form,source?.id);await cache.invalidateQueries({queryKey:["inventory"]});setInitial(JSON.stringify(form));if(!source){allowLeave();navigate(`/catalog/sources/${saved.id}`);}else a.setMessage("Inventory location saved.");});}}><h2>Location details</h2><Notice error>{a.error}</Notice><Notice>{a.message}</Notice>{!canWrite&&<p>Location details are read-only. Inventory management permission is required to change them.</p>}<fieldset disabled={!canWrite||a.busy}><legend className="sr-only">Location details</legend><div className="form-grid">
 <Field label="Code" required maxLength={64} pattern="[A-Za-z0-9_-]+" value={form.code} onChange={e=>update("code",e.target.value)}/>
 <Field label="Name" required maxLength={100} value={form.name} onChange={e=>update("name",e.target.value)}/>
 <Field label="Address" maxLength={500} value={form.address} onChange={e=>update("address",e.target.value)}/>
 <Field label="Contact name" maxLength={100} value={form.contact_name} onChange={e=>update("contact_name",e.target.value)}/>
 <Field label="Contact phone" maxLength={100} value={form.contact_phone} onChange={e=>update("contact_phone",e.target.value)}/>
 <Field label="Display priority" type="number" step="1" value={form.priority} onChange={e=>update("priority",Number(e.target.value))}/>
 <Field label="Pin latitude" type="number" min="-90" max="90" step="any" required={form.longitude!==null} value={form.latitude??""} onChange={e=>update("latitude",e.target.value===""?null:Number(e.target.value))}/>
 <Field label="Pin longitude" type="number" min="-180" max="180" step="any" required={form.latitude!==null} value={form.longitude??""} onChange={e=>update("longitude",e.target.value===""?null:Number(e.target.value))}/>
 </div>{canWrite&&<p className="help">Click the map, drag the pin, or enter warehouse coordinates. Source deduction priority is set on the stock.</p>}
 {canWrite&&!a.busy&&<SourceMap latitude={form.latitude} longitude={form.longitude} onChange={(latitude,longitude)=>setForm(f=>({...f,latitude,longitude}))}/>}
 <label className="checkbox"><input type="checkbox" checked={form.is_enabled} onChange={e=>update("is_enabled",e.target.checked)}/>Enabled</label></fieldset>{canWrite&&<button disabled={a.busy}>{a.busy?"Saving…":"Save inventory location"}</button>} <Link className="secondary button-link" to="/catalog/sources">Back to locations</Link></form>{source ? canReadPickup ? <LocationPickup source={source} canManage={!!canManagePickup} onDirtyChange={setPickupDirty}/> : <section className="form-card"><h2>Store pickup</h2><p>Viewing pickup settings requires fulfillment settings access.</p></section> : <p className="help">Save this inventory location first, then connect stores and configure pickup.</p>}</>;
}
const emptyStock:StockPoolInput={code:"",name:"",is_default:false,is_global:false,sources:[]};
export function Stocks({canWrite}:{canWrite:boolean}) {
 const q=useGrid("stocks",["inventory","stocks"]),sources=useGrid("sources",["inventory","sources"]);
 const a=useAction(),cache=useQueryClient();
 const sourceName=(id:string)=>sources.data?.find(x=>x.id===id)?.name??id;
 return <main className="catalog-admin stock-admin"><PageHeader title={<>Stock pools</>} description={<>Group inventory locations into sellable pools. Global stock exposes availability worldwide. Delivery coverage is checked separately. The default stock serves storefront carts. Lower priority numbers are deducted first.</>} actions={<>{canWrite&&<Link className="primary-link stock-create-link" to="/catalog/stocks/new">Create new stock</Link>}</>} /><section className="stock-command-panel"><div><strong>Adobe Commerce MSI model</strong><p>Stocks are salable pools. Inventory locations are physical branches or warehouses assigned to a stock pool with deduction priority.</p></div><div><span>{q.data?.length??0}</span><small>stocks</small></div><div><span>{sources.data?.length??0}</span><small>locations</small></div></section>{q.controls}<Notice error>{q.error?.message||sources.error?.message||a.error}</Notice>
 <div className="stock-table-wrap"><table><thead><tr><EntityIdHeading/><th>Stock</th><th>Type</th><th>Assigned locations</th><th>Deduction priority</th><th>Actions</th></tr></thead><tbody>{q.data?.map(s=><tr key={s.id}><EntityIdCell row={s}/><td><strong>{s.name}</strong><small><code>{s.code}</code></small></td><td><span className={`status-pill ${s.is_default?"success":"pending"}`}>{s.is_global?"Global stock":s.is_default?"Default storefront stock":"Channel stock"}</span></td><td>{s.sources.length}</td><td><ol className="stock-source-list compact">{deductionOrder(s).map(l=><li key={l.source_id}><span>{sourceName(l.source_id)}</span><small>{l.priority}</small></li>)}</ol></td><td>{canWrite&&<RowActions label={s.name} items={[{label:"Edit",to:`/catalog/stocks/${s.id}`},{label:"Delete",destructive:true,disabled:s.is_default,reason:s.is_default?"The default stock cannot be deleted":undefined,confirm:"Delete this stock pool? Stocks in use may not be deleted.",onSelect:async()=>{await msiApi.deleteStock(s.id);await cache.invalidateQueries({queryKey:["inventory"]});}}]}/>}</td></tr>)}</tbody></table></div></main>;
}
export function StockEditor({canWrite}:{canWrite:boolean}) {
 const {id}=useParams(),navigate=useNavigate();
 const editing=id&&id!=="new";
 const stocks=useQuery({queryKey:["inventory","stocks"],queryFn:msiApi.stocks});
 const sources=useQuery({queryKey:["inventory","sources"],queryFn:msiApi.sources});
 const existing=stocks.data?.find(s=>s.id===id);
 const [form,setForm]=useState<StockPoolInput>(emptyStock);
 const [initial,setInitial]=useState(JSON.stringify(emptyStock));
 const allowLeave=useUnsavedChanges(JSON.stringify(form)!==initial);
 const a=useAction(),cache=useQueryClient();
 useEffect(()=>{const next=existing?{code:existing.code,name:existing.name,is_default:existing.is_default,is_global:existing.is_global,sources:[...existing.sources]}:emptyStock;if(existing||!editing){setForm(next);setInitial(JSON.stringify(next));}},[existing,editing]);
 const assigned=useMemo(()=>deductionOrder(form),[form]);
 const sourceById=(sourceId:string)=>sources.data?.find(s=>s.id===sourceId);
 const toggle=(source_id:string,checked:boolean)=>setForm(setSourceAssignment(form,source_id,checked));
 const priority=(source_id:string,next:number)=>setForm(setSourcePriority(form,source_id,next));
 if(!canWrite)return <main><PageHeader title={<>Stock pools</>} description={<>You do not have permission to edit stocks.</>} /></main>;
 return <main className="catalog-admin stock-admin stock-editor-page"><Link to="/catalog/stocks" className="back-link">Stocks</Link><PageHeader title={<>{editing?"Edit stock":"Create new stock"}</>} description={<>This is a dedicated stock setup page. Define the salable pool, assign sources, then review deduction order before saving.</>} /><Notice error>{a.error||stocks.error?.message||sources.error?.message}</Notice>{editing&&stocks.data&&!existing?<Notice error>Stock not found.</Notice>:<form className="stock-editor" onSubmit={e=>{e.preventDefault();void a.run(async()=>{await msiApi.saveStock(form,editing?id:undefined);await cache.invalidateQueries({queryKey:["inventory"]});allowLeave();navigate("/catalog/stocks");});}}><section className="stock-editor-hero"><div><span className="status-pill pending">Step 1</span><h2>Stock information</h2><p>Use a stable stock code for integrations, delivery area mapping, and channel availability.</p></div><label className="checkbox"><input type="checkbox" checked={form.is_default} onChange={e=>setForm({...form,is_default:e.target.checked})}/>Default storefront stock</label><label className="checkbox"><input type="checkbox" checked={form.is_global ?? false} onChange={e=>setForm({...form,is_global:e.target.checked})}/>Global stock (worldwide availability)</label></section><section className="order-panel"><div className="form-grid"><Field label="Stock code" required maxLength={64} pattern="[A-Za-z0-9_-]+" value={form.code} onChange={e=>setForm({...form,code:e.target.value})}/><Field label="Stock name" required maxLength={100} value={form.name} onChange={e=>setForm({...form,name:e.target.value})}/></div></section><section className="stock-editor-hero"><div><span className="status-pill pending">Step 2</span><h2>Sources and priorities</h2><p>Assign physical sources to this stock. Lower numbers are deducted before higher numbers.</p></div><strong>{form.sources.length} assigned</strong></section>{sources.isPending?<p className="order-panel">Loading sources...</p>:<div className="stock-assignment-layout"><section className="order-panel source-picker-panel"><h3>Available sources</h3>{sources.data?.map(s=>{const link=form.sources.find(l=>l.source_id===s.id);return <article className={`source-assignment ${link?"selected":""}`} key={s.id}><label className="checkbox"><input type="checkbox" checked={!!link} onChange={e=>toggle(s.id,e.target.checked)}/><span><strong>{s.name}</strong><small><code>{s.code}</code> · {s.is_enabled?"Enabled":"Disabled"} · {s.address||"No address"}</small></span></label>{link&&<Field label="Deduction priority" type="number" step="1" value={link.priority} onChange={e=>priority(s.id,Number(e.target.value))}/>}</article>;})}</section><aside className="order-panel deduction-panel"><h3>Deduction order</h3>{assigned.length===0?<p>No sources assigned yet.</p>:<ol className="stock-source-list">{assigned.map(l=>{const source=sourceById(l.source_id);return <li key={l.source_id}><span>{source?.name??l.source_id}</span><small>priority {l.priority}</small></li>;})}</ol>}</aside></div>}<div className="stock-save-bar"><Link className="secondary button-link" to="/catalog/stocks">Cancel</Link><button disabled={a.busy||form.sources.length===0}>{a.busy?"Saving...":"Save stock"}</button></div></form>}</main>;
}
export function SourceQuantities({productId,canWrite}:{productId:string;canWrite:boolean}) {
 const q=useGrid("source-items",["inventory","source-items",productId],{product_id:productId});
 return <section><h3>Stock by source</h3>{q.controls}<Notice error>{q.error?.message}</Notice>{q.isPending?<p>Loading source stock…</p>:q.data?.map(i=><SourceQuantity key={`${productId}:${i.source_id}`} item={i} canWrite={canWrite}/>)}</section>;
}
function SourceQuantity({item,canWrite}:{item:SourceItem;canWrite:boolean}) {
 const a=useAction(),cache=useQueryClient();
 return <form className="form-card" onSubmit={e=>{e.preventDefault();const data=new FormData(e.currentTarget);void a.run(async()=>{await msiApi.adjust(item.product_id,{source_id:item.source_id,quantity:Number(data.get("quantity")),status:data.get("status")==="in_stock"?"in_stock":"out_of_stock",notify_stock_qty:Number(data.get("notify_stock_qty")),reason:String(data.get("reason"))});await cache.invalidateQueries({queryKey:["inventory"]});a.setMessage("Source stock saved.");});}}><h4>{item.name}</h4><p>{item.quantity} on hand · {item.reserved} reserved · status: {item.status.replaceAll("_"," ")}</p>{canWrite&&<><div className="form-grid"><Field label="Quantity" name="quantity" type="number" required min={item.reserved} max="1000000" step="1" defaultValue={item.quantity}/><label className="field">Status<select name="status" defaultValue={item.status}><option value="in_stock">In stock</option><option value="out_of_stock">Out of stock</option></select></label><Field label="Low stock threshold" name="notify_stock_qty" type="number" min="0" max="1000000" step="1" required defaultValue={item.notify_stock_qty}/><ReasonField label="Adjustment reason" options={reasonOptions.inventory} name="reason" required maxLength={300}/></div><button disabled={a.busy}>Save source quantity</button></>}<Notice error>{a.error}</Notice><Notice>{a.message}</Notice></form>;
}

export function ProductSourceQuantities({productId}:{productId:string}) {
 const who=useQuery({queryKey:["admin-me"],queryFn:adminApi.me});
 const permissions=who.data?.permissions??[];
 if(!permissions.includes("*")&&!permissions.includes("inventory.read")) return null;
 return <SourceQuantities productId={productId} canWrite={permissions.includes("*")||permissions.includes("inventory.write")}/>;
}
