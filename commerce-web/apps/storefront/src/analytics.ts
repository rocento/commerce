import { discoverySession, trackDiscovery, measurementAllowed } from './discovery-attribution';
import { catalogApi } from "@commerce/api-client";
let session:string;
function source():"direct"|"search"|"social"|"email"|"referral"|"unknown" {
  const saved=sessionStorage.getItem("browse-source");
  if(saved&&["direct","search","social","email","referral","unknown"].includes(saved))return saved as ReturnType<typeof source>;
  const medium=new URLSearchParams(location.search).get("utm_medium");
  let result:ReturnType<typeof source>="direct";
  if(medium==="email")result="email";
  else if(medium==="social")result="social";
  else if(medium==="cpc"||medium==="organic")result="search";
  else if(document.referrer){try{const host=new URL(document.referrer).hostname;result=/(^|\.)(google|bing|duckduckgo)\./.test(host)?"search":/(^|\.)(facebook|instagram|tiktok|twitter|x)\./.test(host)?"social":"referral";}catch{result="unknown";}}
  sessionStorage.setItem("browse-source",result);return result;
}
export function track(event_type:"page_view"|"search_query"|"cart_added"|"checkout_started"|"order_placed",path:string,query?:string,result_count?:number,id:string=crypto.randomUUID()) {
  try{
    if(!measurementAllowed())return;
    session=discoverySession();
    if(event_type==="page_view"||event_type==="order_placed")trackDiscovery(path,id,event_type==="order_placed"?id:undefined);
    void catalogApi.event({id,session_id:session,event_type,path,source:source(),...(query!==undefined?{query,result_count}:{})}).catch(()=>{});
  }catch{/* Analytics never blocks shopping. */}
}
