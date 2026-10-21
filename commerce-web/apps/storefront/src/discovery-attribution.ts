import { customerSessionHeaders } from '@commerce/api-client';
let attributionEnabled = false;
// The public bootstrap reports whether this installation accepts attribution.
// Indexing preferences and noindex directives do not determine measurement.
export function configureDiscoveryAttribution(enabled:boolean){attributionEnabled=enabled;}
export function measurementAllowed(){return !(navigator as Navigator & {globalPrivacyControl?:boolean}).globalPrivacyControl && navigator.doNotTrack!=='1';}
// Shared with legacy browse analytics; storage failure never blocks storefront use.
export function discoverySession(now=Date.now()):string {
  let session=sessionStorage.getItem('browse-session');const seen=Number(sessionStorage.getItem('discovery-last-seen')||0);
  if(!session||!seen||now-seen>30*60*1000){session=crypto.randomUUID();sessionStorage.setItem('browse-session',session);sessionStorage.removeItem('browse-source');}
  sessionStorage.setItem('discovery-last-seen',String(now));return session;
}
export function discoveryEvidence(url:string,referrer:string){
  const target=new URL(url);const token=(key:string)=>{const values=target.searchParams.getAll(key);return values.length===1&&/^[A-Za-z0-9_.-]{0,80}$/.test(values[0])?values[0]:values.length?'__invalid__':'';};
  let origin='';try{const r=new URL(referrer);if(['http:','https:'].includes(r.protocol)&&!r.username&&!r.password)origin=r.origin;}catch{/* Missing or malformed referrer stays unknown when present. */}
  return {referrer:origin||(referrer?'invalid':''),source:token('utm_source'),medium:token('utm_medium'),campaign:token('utm_campaign')};
}
export function redirectEvidence(cookie:string):ReturnType<typeof discoveryEvidence>|null {
  try {const raw=cookie.split('; ').find(v=>v.startsWith('discovery-entry='));if(!raw)return null;
    const value=JSON.parse(decodeURIComponent(raw.slice('discovery-entry='.length))) as Record<string,unknown>;
    const url=new URL('https://claim.invalid/');for(const k of ['source','medium','campaign'])if(typeof value[k]==='string')url.searchParams.set(`utm_${k}`,value[k] as string);
    return discoveryEvidence(url.href,typeof value.referrer==='string'?value.referrer:'');
  }catch{return null;}
}
export function trackDiscovery(path:string,id:string=crypto.randomUUID(),orderId?:string){
  try {
    if(!attributionEnabled||!measurementAllowed())return;
    const session=discoverySession();
    const captured=redirectEvidence(document.cookie);
    if(captured)document.cookie='discovery-entry=; Max-Age=0; Path=/; Secure; SameSite=Lax';
    const direct=discoveryEvidence(location.href,document.referrer);
    const evidence=direct.source||direct.medium||direct.campaign?direct:(captured||direct);
    const body={id,session_id:session,path,evidence,...(orderId?{order_id:orderId}:{})};
    void fetch('/api/v1/discovery/attribution',{method:'POST',credentials:'include',keepalive:true,headers:{'content-type':'application/json','X-Commerce-Request':'1',...(orderId?customerSessionHeaders():{})},body:JSON.stringify(body)}).catch(()=>{});
  }catch{/* Measurement is best effort and never blocks commerce. */}
}
