import { entityInput } from "./entity-id";
export type DeliveryPin={latitude:number;longitude:number};
export type DeliveryStatus={configured:boolean;deliverable:boolean;area_id:string|null};
export type DeliveryArea={id:string;readonly entity_id?:number;name:string;boundary?:DeliveryPin[]|null;center_lat:number;center_lng:number;radius_km:number;priority:number;is_active:boolean;stocks:{stock_id:string;priority:number}[]};
export type DeliveryAreaChoice=Pick<DeliveryArea,"id"|"entity_id"|"name"|"center_lat"|"center_lng">;
let current:DeliveryPin|null=null;
export function setDeliveryPin(pin:DeliveryPin|null){
  const next=pin&&Number.isFinite(pin.latitude)&&Number.isFinite(pin.longitude)?{latitude:pin.latitude,longitude:pin.longitude}:null;
  if(JSON.stringify(current)===JSON.stringify(next))return;
  current=next;window.dispatchEvent(new Event("commerce-delivery"));
}
export function deliveryHeaders():Record<string,string>{return {"x-delivery-context":"1",...(current?{"x-delivery-latitude":String(current.latitude),"x-delivery-longitude":String(current.longitude)}:{})};}
export function deliveryKey(){return current?`${current.latitude},${current.longitude}`:"none";}
async function request<T>(path:string,body?:unknown,method="GET",headers:Record<string,string>={}):Promise<T>{
 const r=await fetch(`/api/v1/${path}`,{method,credentials:"include",headers:{...deliveryHeaders(),...headers,"X-Commerce-Request":"1","Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await r.json();if(!r.ok)throw new Error(data.error||"Request failed");return data;
}
export const deliveryApi={
 resolve:()=>request<DeliveryStatus>("delivery-area"),
 check:(pin:DeliveryPin)=>request<DeliveryStatus>("delivery-area",undefined,"GET",{"x-delivery-latitude":String(pin.latitude),"x-delivery-longitude":String(pin.longitude)}),
 choices:()=>request<DeliveryAreaChoice[]>("delivery-areas"),
 areas:()=>request<DeliveryArea[]>("admin/inventory/delivery-areas"),
 stocks:()=>request<{id:string;name:string}[]>("admin/inventory/stocks"),
 save:(id:string|null,body:Pick<DeliveryArea,"name"|"priority"|"is_active"|"stocks"> & {boundary:DeliveryPin[]})=>request<{id:string}>(`admin/inventory/delivery-areas${id?`/${id}`:""}`,entityInput(body),id?"PUT":"POST"),
};
