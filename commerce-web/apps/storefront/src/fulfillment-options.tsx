import { useInterface } from './interface-locale';
import { hasAvailableSelections } from './fulfillment-selection';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fulfillmentPlanApi, type FulfillmentAvailability, type FulfillmentPlan, type DeliverySlot, type FulfillmentRequest } from '@commerce/api-client';
import { Notice } from '@commerce/ui';
export function FulfillmentOptions({availability,method,locationId,locked,autoReserve=false,expiredPlanId='',onSelected,onInvalidated}:{availability:FulfillmentAvailability;method:'delivery'|'pickup';locationId:string|null;locked:boolean;autoReserve?:boolean;expiredPlanId?:string;onSelected:(p:FulfillmentPlan)=>void;onInvalidated:()=>void}) {
  const { message } = useInterface();
  const { t: ui, locale } = useInterface();
 const cap=availability.capabilities;
 const [date,setDate]=useState(()=>new Date().toLocaleDateString('en-CA')), [source,setSource]=useState(''),[asap,setAsap]=useState(method==='delivery'&&!cap.scheduled_delivery_enabled);
 const [chosen,setChosen]=useState<Record<string,DeliverySlot>>({}),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const scheduled=method==='pickup'?cap.pickup_scheduling_enabled:cap.scheduled_delivery_enabled&&!asap;
 const request:FulfillmentRequest={method,location_id:method==='pickup'?null:locationId,source_id:source||null,date,asap:method==='pickup'?!scheduled:asap};
 const locations=availability.methods.find(m=>m.type===method)?.locations??[];
 const options=useQuery({queryKey:['fulfillment-options',request],queryFn:()=>fulfillmentPlanApi.options(request),enabled:!locked&&(method==='pickup'?!!source:!!locationId)&&((cap.automatic_source_routing_enabled)||!!source),retry:false,refetchInterval:30000});
 const common=cap.split_delivery_mode==='same_window_required';
 const automatic=method==='delivery'&&!cap.customer_delivery_slot_selection_enabled;
 const canReserve=!options.isFetching&&!options.error&&!!options.data?.groups.length&&(!scheduled||automatic||hasAvailableSelections(options.data.groups,chosen));
 const renewal=useRef('');if(expiredPlanId)renewal.current=expiredPlanId;
 const selectionKey=JSON.stringify([request,scheduled&&!automatic?chosen:{},renewal.current]);
 const currentSelection=useRef(selectionKey);currentSelection.current=selectionKey;
 const mounted=useRef(false),inFlight=useRef(false),attempted=useRef('');
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 async function reserve(){
  if(inFlight.current||locked||!canReserve)return;
  const key=selectionKey;
  inFlight.current=true;attempted.current=key;setBusy(true);setError('');
  try{
   const windows=scheduled&&!automatic?Object.values(chosen):[];
   const result=await fulfillmentPlanApi.reserve(request,windows,crypto.randomUUID());
   if(!mounted.current||currentSelection.current!==key){void fulfillmentPlanApi.release(result.id).catch(()=>{});return;}
   onSelected(result);
  }catch(e){if(mounted.current&&currentSelection.current===key){setError(e instanceof Error?e.message:'Please retry availability.');onInvalidated();}}
  finally{inFlight.current=false;if(mounted.current)setBusy(false);}
 }
 const reserveLatest=useRef(reserve);reserveLatest.current=reserve;
 useEffect(()=>{
  if(autoReserve&&canReserve&&!locked&&!busy&&attempted.current!==selectionKey)void reserveLatest.current();
 },[autoReserve,canReserve,locked,busy,selectionKey]);

 return <section className="checkout-section"><h2>{method==='pickup'?ui("storefront.pickup_location_time", "Pickup location & time"):autoReserve?ui("storefront.delivery_options", "Delivery options"):ui("storefront.delivery_availability", "Delivery availability")}</h2>
 {method==='pickup' ? <fieldset className="saved-address-list" disabled={locked||busy}><legend>{ui("storefront.choose_a_pickup_location", "Choose a pickup location")}</legend>{locations.map(location=><label key={location.id} className="saved-address-option" data-selected={source===location.id}>
 <input type="radio" name="checkout-pickup-location" checked={source===location.id} onChange={()=>{setSource(location.id);setChosen({});onInvalidated();}}/>
 <span className="saved-address-details"><strong>{location.name}</strong>{location.instructions&&<span>{location.instructions}</span>}<span>{ui("fulfillment.preparation", "Estimated preparation: {minutes} minutes. Availability is confirmed below.", {minutes:location.preparation_minutes})}</span><strong className="saved-address-selection">{source===location.id?ui("storefront.collect_here", "Collect here"):ui("storefront.select_location", "Select location")}</strong></span>
 </label>)}</fieldset> : !cap.automatic_source_routing_enabled&&<label>{ui("storefront.delivery_location_2", "Delivery location")}<select aria-label={ui("storefront.delivery_location_2", "Delivery location")} value={source} disabled={locked||busy} onChange={e=>{setSource(e.target.value);setChosen({});onInvalidated();}}><option value="">{ui("storefront.choose_a_location", "Choose a location")}</option>{locations.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</select><p>{locations.find(l=>l.id===source)?.instructions}</p></label>}

 {method==='delivery'&&cap.scheduled_delivery_enabled&&cap.asap_delivery_enabled&&<label>{ui("storefront.delivery_timing", "Delivery timing")}<select value={asap?'asap':'scheduled'} onChange={e=>{setAsap(e.target.value==='asap');setChosen({});onInvalidated();}}><option value="asap">{ui("storefront.as_soon_as_possible", "As soon as possible")}</option><option value="scheduled">{ui("storefront.choose_a_window", "Choose a window")}</option></select></label>}
 {scheduled&&!automatic&&<label>{ui("storefront.date", "Date")}<input type="date" value={date} onChange={e=>{setDate(e.target.value);setChosen({});onInvalidated();}}/></label>}
 {method==='pickup'&&locations.length===0&&<p>{ui("storefront.no_pickup_locations_can_fulfill_your_cart_right_now", "No pickup locations can fulfill your cart right now.")}</p>}
 <Notice error>{message((error||options.error?.message) || '')}</Notice>{options.isFetching&&<p role="status">{ui("storefront.checking_stock_and_availability", "Checking stock and availability…")}</p>}
 {scheduled&&!automatic&&options.data&&(common?<div>{options.data.common_windows.length===0&&<p>{ui("storefront.no_common_windows_try_another_date", "No common windows. Try another date.")}</p>}{options.data.common_windows.map(([start,end])=><button type="button" className="secondary" key={start} aria-pressed={Object.values(chosen)[0]?.starts_at===start} onClick={()=>{onInvalidated();setChosen(Object.fromEntries(options.data!.groups.map(g=>[g.source_id,g.slots.find(s=>s.starts_at===start&&s.ends_at===end)!])));}}>{new Date(start).toLocaleTimeString(locale === "ar" ? "ar" : undefined)}–{new Date(end).toLocaleTimeString(locale === "ar" ? "ar" : undefined)}</button>)}</div>:options.data.groups.map(g=><label key={g.source_id}>{g.source_name}<select value={chosen[g.source_id]?.starts_at??''} onChange={e=>{onInvalidated();setChosen({...chosen,[g.source_id]:g.slots.find(s=>s.starts_at===e.target.value)!});}}><option value="">{ui("storefront.choose_a_window", "Choose a window")}</option>{g.slots.map(s=><option key={s.starts_at} value={s.starts_at}>{new Date(s.starts_at).toLocaleString(locale === "ar" ? "ar" : undefined)}–{new Date(s.ends_at).toLocaleTimeString(locale === "ar" ? "ar" : undefined)}</option>)}</select></label>))}
 {!autoReserve&&options.data?.groups.map(g=><p key={g.source_id}>{g.source_name} · {ui("cart.item_count", "{count} items", {count:g.items.reduce((n,i)=>n+i.quantity,0)})}</p>)}
 {!scheduled&&<p>{method==='pickup'?ui("storefront.ready_asap_after_preparation", "Ready ASAP after preparation."):ui("storefront.delivery_as_soon_as_possible", "Delivery as soon as possible.")}</p>}
 {(!autoReserve||!!error)&&<button type="button" disabled={!canReserve||busy||locked} onClick={()=>void reserve()}>{busy?ui("storefront.checking", "Checking…"):autoReserve?ui("storefront.retry_availability", "Retry availability"):method==='pickup'?ui("storefront.confirm_pickup_location_and_time", "Confirm pickup location and time"):ui("storefront.confirm_delivery_availability", "Confirm delivery availability")}</button>}
 {autoReserve&&busy&&<p role="status">{ui("storefront.preparing_your_total", "Preparing your total…")}</p>}
 {autoReserve&&options.error&&<button type="button" disabled={options.isFetching||locked} onClick={()=>void options.refetch()}>{ui("storefront.retry_availability", "Retry availability")}</button>}
 </section>;
}
