import { useUnsavedChanges } from './unsaved-changes';
import { RowActions } from "./row-actions";
import { PageHeader } from "./page-header";
import { useLocalGrid } from "./local-grid";
import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router-dom";
import { replenishmentApi, type ReplenishmentPolicyInput, type ReplenishmentRecommendation } from "@commerce/api-client";
import { Notice } from "@commerce/ui";
import "./replenishment.css";

const number=(value:number,digits=0)=>new Intl.NumberFormat(undefined,{maximumFractionDigits:digits}).format(value);
const days=(value:number|null)=>value===null?"—":`${number(value,1)} days`;
const date=(value:string|null)=>value?new Date(value).toLocaleDateString():"—";
function urgency(row:ReplenishmentRecommendation){
  if(!row.enabled)return ["Paused","muted"];
  if(row.sales_velocity<=0)return ["No sales history","muted"];
  if((row.replenishment_in_days??999)<=row.lead_time_days)return ["Order now","danger"];
  if(row.replenishment_qty>0)return ["Plan order","warning"];
  return ["Healthy","success"];
}

export function Replenishment({canWrite}:{canWrite:boolean}){
 const cache=useQueryClient();
 const q=useQuery({queryKey:["replenishment"],queryFn:replenishmentApi.list});
 const [supplier,setSupplier]=useState("all"),[attention,setAttention]=useState(false),[expanded,setExpanded]=useState<string>();
 const refresh=useMutation({mutationFn:replenishmentApi.refresh,onSuccess:async()=>cache.invalidateQueries({queryKey:["replenishment"]})});
 const suppliers=useMemo(()=>[...new Set((q.data??[]).map(x=>x.supplier).filter(Boolean))].sort(),[q.data]);
 const filtered=(q.data??[]).filter(x=>(supplier==="all"||x.supplier===supplier)&&(!attention||x.replenishment_qty>0));
 const grid=useLocalGrid({name:"replenishment",rows:filtered,searchText:x=>`${x.product} ${x.sku} ${x.supplier} ${x.planning_group}`,sorts:{product:x=>x.product,sku:x=>x.sku,supplier:x=>x.supplier,replenishment_qty:x=>x.replenishment_qty,days_of_stock:x=>x.days_of_stock},initialSort:"product",scope:JSON.stringify([supplier,attention]),busy:q.isFetching,error:q.error?.message,refresh:()=>void q.refetch()});
 const rows=grid.data;
 const summary=useMemo(()=>({order:(q.data??[]).filter(x=>x.replenishment_qty>0&&x.enabled).length,units:(q.data??[]).reduce((n,x)=>n+x.replenishment_qty,0),risk:(q.data??[]).filter(x=>x.sales_velocity>0&&(x.days_of_stock??999)<=x.lead_time_days).length,overstock:(q.data??[]).reduce((n,x)=>n+x.overstock_qty,0)}),[q.data]);
 return <main className="replenishment-page">
  <PageHeader title={<>Replenishment</>} description={<>Forecast stockouts and turn demand into supplier-ready reorder recommendations.</>} actions={<>{canWrite&&<button disabled={refresh.isPending} onClick={()=>refresh.mutate()}>{refresh.isPending?"Updating…":"Update recommendations"}</button>}</>} />
  <Notice error>{q.error?.message||refresh.error?.message}</Notice>
  <section className="planner-kpis"><article><span>Products to order</span><strong>{summary.order}</strong><small>Enabled policies with suggested quantity</small></article><article><span>Recommended units</span><strong>{number(summary.units)}</strong><small>Across the current catalog</small></article><article><span>Stockout risk</span><strong>{summary.risk}</strong><small>Cover is within supplier lead time</small></article><article><span>Overstock units</span><strong>{number(summary.overstock)}</strong><small>Above twice the target horizon</small></article></section>
  {grid.renderControls({filters:<><label className="grid-field">Supplier<select value={supplier} onChange={e=>setSupplier(e.target.value)}><option value="all">All suppliers</option>{suppliers.map(x=><option key={x}>{x}</option>)}</select></label><label className="checkbox"><input type="checkbox" checked={attention} onChange={e=>setAttention(e.target.checked)}/> Needs replenishment</label></>,chips:[...(supplier!=="all"?[{label:`Supplier: ${supplier}`,remove:()=>setSupplier("all")}]:[]),...(attention?[{label:"Needs replenishment",remove:()=>setAttention(false)}]:[])],clearFilters:()=>{setSupplier("all");setAttention(false);}})}
  <div className="table-wrap planner-table"><table><thead><tr><th>Product</th><th>Supplier / group</th><th>Saleable</th><th>Velocity</th><th>Stock cover</th><th>Sales 7 / 30 / 90</th><th>Lead time</th><th>Recommended</th><th>Status</th><th></th></tr></thead><tbody>
   {rows.map(row=>{const status=urgency(row);return <Fragment key={row.product_id}><tr><td><strong>{row.product}</strong><small>{row.sku}</small></td><td>{row.supplier||"Unassigned"}<small>{row.planning_group||"No group"}</small></td><td>{number(row.saleable_qty)}<small>{number(row.on_hand)} on hand · {number(row.reserved)} reserved</small></td><td>{number(row.sales_velocity,2)}<small>units / day</small></td><td>{days(row.days_of_stock)}<small>{row.overstock_qty>0?`${number(row.overstock_qty)} overstock`:row.last_sold_at?`Last sold ${date(row.last_sold_at)}`:"Never sold"}</small></td><td>{row.sales_7_days} / {row.sales_30_days} / {row.sales_90_days}<small>{number(row.total_sales)} total</small></td><td>{row.lead_time_days} days<small>{row.target_cover_days} target + {row.safety_stock_days} safety</small></td><td><strong>{number(row.replenishment_qty)} units</strong><small>{row.recommended_date?`By ${date(row.recommended_date)}`:"No order date"}</small></td><td><span className={`badge ${status[1]}`}>{status[0]}</span></td><td><RowActions label={row.product} items={[{label:"Warehouses",onSelect:()=>setExpanded(expanded===row.product_id?undefined:row.product_id)},...(canWrite?[{label:"Configure",to:`/fulfillment/replenishment/${row.product_id}`}]:[])]}/></td></tr>{expanded===row.product_id&&<tr className="warehouse-row"><td colSpan={10}><div>{row.warehouse_quantities.map(w=><article key={w.source_id}><span>{w.source}</span><strong>{number(w.saleable)} saleable</strong><small>{number(w.on_hand)} on hand</small></article>)}</div></td></tr>}</Fragment>})}
   {!q.isPending&&!rows.length&&<tr><td colSpan={10} className="empty-admin">No products match these filters.</td></tr>}
  </tbody></table></div>
 </main>;
}

export function ReplenishmentPolicyPage(){
 const {id}=useParams(),navigate=useNavigate(),cache=useQueryClient();
 const q=useQuery({queryKey:["replenishment"],queryFn:replenishmentApi.list});
 const row=q.data?.find(x=>x.product_id===id);
 const [draft,setDraft]=useState<ReplenishmentPolicyInput>();
 const allowLeave=useUnsavedChanges(!!draft);
 const form=draft??(row&&{supplier:row.supplier,planning_group:row.planning_group,lead_time_days:row.lead_time_days,target_cover_days:row.target_cover_days,safety_stock_days:row.safety_stock_days,minimum_order_qty:row.minimum_order_qty,order_multiple:row.order_multiple,enabled:row.enabled});
 const save=useMutation({mutationFn:(body:ReplenishmentPolicyInput)=>replenishmentApi.save(id!,body),onSuccess:async()=>{await cache.invalidateQueries({queryKey:["replenishment"]});allowLeave();navigate("/fulfillment/replenishment");}});
 const update=<K extends keyof ReplenishmentPolicyInput>(key:K,value:ReplenishmentPolicyInput[K])=>setDraft({...form!,[key]:value});
 if(q.isPending)return <main><p role="status">Loading replenishment policy…</p></main>;
 if(!row||!form)return <main className="product-detail-page"><PageHeader title={<>Policy unavailable</>} /><Notice error>Product or replenishment policy was not found.</Notice><button onClick={()=>navigate("/fulfillment/replenishment")}>Back to replenishment</button></main>;
 return <main className="product-detail-page replenishment-policy">
  <button className="text-button back-link" onClick={()=>navigate("/fulfillment/replenishment")}>← Replenishment</button>
  <PageHeader title={<>{row.product}</>} description={<>Configure replenishment for <strong>{row.sku}</strong>. Changes affect future recommendations.</>} />
  <Notice error>{save.error?.message}</Notice>
  <div className="policy-layout">
   <form className="policy-form-card" onSubmit={e=>{e.preventDefault();save.mutate(form);}}>
    <div className="policy-switch"><div><strong>Planning enabled</strong><small>Include this product in reorder recommendations.</small></div><label className="switch-control"><input aria-label="Planning enabled" type="checkbox" checked={form.enabled} onChange={e=>update("enabled",e.target.checked)}/><span/></label></div>
    <div className="policy-section"><header><h2>Supply details</h2><p>Identify who supplies this item and how purchasing teams group it.</p></header><div className="policy-grid"><label><span>Primary supplier</span><input maxLength={160} placeholder="e.g. Fresh Foods Co." value={form.supplier} onChange={e=>update("supplier",e.target.value)}/></label><label><span>Planning group</span><input maxLength={120} placeholder="e.g. Fresh produce" value={form.planning_group} onChange={e=>update("planning_group",e.target.value)}/></label></div></div>
    <div className="policy-section"><header><h2>Stock targets</h2><p>Set the demand horizon used to decide when and how much to reorder.</p></header><div className="policy-grid policy-number-grid"><label><span>Lead time</span><input type="number" required step="1" min="0" max="3650" value={form.lead_time_days} onChange={e=>update("lead_time_days",Number(e.target.value))}/><small>Days from order to receipt</small></label><label><span>Target stock cover</span><input type="number" required step="1" min="1" max="3650" value={form.target_cover_days} onChange={e=>update("target_cover_days",Number(e.target.value))}/><small>Days of demand to hold</small></label><label><span>Safety stock</span><input type="number" required step="1" min="0" max="3650" value={form.safety_stock_days} onChange={e=>update("safety_stock_days",Number(e.target.value))}/><small>Extra days for uncertainty</small></label></div></div>
    <div className="policy-section"><header><h2>Ordering constraints</h2><p>Match supplier packaging and purchasing requirements.</p></header><div className="policy-grid"><label><span>Minimum order quantity</span><input type="number" required step="1" min="1" max="1000000" value={form.minimum_order_qty} onChange={e=>update("minimum_order_qty",Number(e.target.value))}/></label><label><span>Order multiple</span><input type="number" required step="1" min="1" max="1000000" value={form.order_multiple} onChange={e=>update("order_multiple",Number(e.target.value))}/></label></div></div>
    <div className="editor-actions policy-actions"><button type="submit" disabled={save.isPending}>{save.isPending?"Saving…":"Save policy"}</button><button type="button" className="secondary" onClick={()=>navigate("/fulfillment/replenishment")}>Cancel</button></div>
   </form>
   <aside className="policy-summary"><span className="eyebrow">CURRENT FORECAST</span><strong>{number(row.replenishment_qty)}<small> units</small></strong><p>{row.replenishment_qty>0?`Recommended by ${date(row.recommended_date)}.`:"No replenishment is currently required."}</p><dl><div><dt>Sales velocity</dt><dd>{number(row.sales_velocity,2)} / day</dd></div><div><dt>Stock cover</dt><dd>{days(row.days_of_stock)}</dd></div><div><dt>Saleable stock</dt><dd>{number(row.saleable_qty)} units</dd></div><div><dt>Lead time</dt><dd>{row.lead_time_days} days</dd></div></dl><small className="summary-note">The preview uses the saved policy. Save changes to recalculate it.</small></aside>
  </div>
 </main>;
}
