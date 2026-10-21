import { traceFetch } from './telemetry';
export type DeliveryFeeRule={id:string;area_id:string|null;country_code:string;state_code:string;city_id:string;location_name:string;source_id:string|null;amount:string};
async function request<T>(suffix:string,body?:unknown):Promise<T> {
 const response=await traceFetch(`/api/v1/admin/settings/delivery-fee-${suffix}`,{method:body===undefined?'GET':'PUT',credentials:'include',headers:{'Content-Type':'application/json','X-Commerce-Request':'1'},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const data=await response.json();if(!response.ok)throw new Error(data.error||'Unable to save delivery fee');return data;
}
export const deliveryFeeApi={
 rules:()=>request<DeliveryFeeRule[]>('rules'),
 choices:()=>request<{areas:{id:string;name:string}[];sources:{id:string;name:string}[]}>('choices'),
 save:(input:Omit<DeliveryFeeRule,'id'|'amount'>&{amount:string|null;reason:string})=>{const {area_id,country_code,state_code,city_id,location_name,source_id,amount,reason}=input;return request('rules',{area_id,country_code,state_code,city_id,location_name,source_id,amount,reason});},
};
