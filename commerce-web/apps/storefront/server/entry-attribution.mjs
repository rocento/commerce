// Carry only non-sensitive campaign tokens through canonical 301 redirects.
// This is an untrusted analytics claim, never an authentication cookie.
export function entryCookie(raw,referrer,headers={}){
 if(headers['sec-gpc']==='1'||headers.dnt==='1')return null;
 const params=new URLSearchParams(raw.split('?')[1]||'');const evidence={};
 for(const [name,key] of [['source','utm_source'],['medium','utm_medium'],['campaign','utm_campaign']]){
  const values=params.getAll(key);evidence[name]=values.length===1&&/^[A-Za-z0-9_.-]{1,80}$/.test(values[0])?values[0]:'';
 }
 if(!Object.values(evidence).some(Boolean))return null;
 evidence.referrer='';try{const u=new URL(referrer);if(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password)evidence.referrer=u.origin;}catch{/* Do not retain malformed or private referrer data. */}
 return `discovery-entry=${encodeURIComponent(JSON.stringify(evidence))}; Max-Age=120; Path=/; Secure; SameSite=Lax`;
}
