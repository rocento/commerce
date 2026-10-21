// Finite-cardinality process observations. No URLs, headers, cookies, IPs or error bodies.
export const codes = new Set(['response','render_failure','unknown_canonical_host','sitemap_failure','invalid_structured_data','redirect_loop','tenant_resolution_failure']);
export function crawler(ua = '') {
  ua=String(ua).slice(0,512);
  if (/Rocento-Publication-Health/i.test(ua)) return 'probe';
  for (const [pattern, name] of [[/\bOAI-SearchBot\b/i,'oai_search'],[/\bGPTBot\b/i,'gptbot'],[/\bGooglebot\b/i,'googlebot'],[/\bBingbot\b/i,'bingbot']]) if (pattern.test(ua)) return name;
  return /bot|crawler|spider/i.test(ua) ? 'other_bot' : 'none';
}
export function routeClass(value = '') { const p=value.split('?')[0];return p.startsWith('/products/')?'product':p.startsWith('/categories/')?'category':p.startsWith('/pages/')?'content':p.includes('sitemap')?'sitemap':p==='/robots.txt'?'robots':p==='/'?'home':'other'; }
export function alertFor(total, errors) { return total >= 10 && errors >= 5 && errors / total >= .2; }
export function createObservations(installationId, emit = row => console.log(JSON.stringify(row)), now = () => Date.now()) {
  const buckets=new Map();const started=now();let lastAlert=-1;
  function prune(){const cutoff=Math.floor(now()/60000)-14;for(const minute of buckets.keys())if(minute<cutoff)buckets.delete(minute);}
  function snapshot(){prune();const rows=[...buckets.values()].flatMap(b=>[...b.values()]);const total=rows.filter(r=>!['none','probe'].includes(r.crawler)).reduce((n,r)=>n+r.count,0);const errors=rows.filter(r=>!['none','probe'].includes(r.crawler)&&['403','429','5xx'].includes(r.status)).reduce((n,r)=>n+r.count,0);return {installation_id:installationId,observed_at:new Date(now()).toISOString(),window_start:new Date(Math.max(started,(Math.floor(now()/60000)-14)*60000)).toISOString(),scope:'renderer process; claimed user agents, not verified bot identity; upstream CDN responses excluded',rows,crawler_requests:total,crawler_errors:errors,alert:alertFor(total,errors)};}
  function record({path,status,userAgent,code='response'}){
    const bot=crawler(userAgent);if(bot==='probe'||path?.startsWith('/__publication/'))return;
    prune();const minute=Math.floor(now()/60000);if(!buckets.has(minute))buckets.set(minute,new Map());
    const row={route:routeClass(path),crawler:bot,status:status>=500?'5xx':status===403?'403':status===429?'429':status>=400?'4xx':status>=300?'3xx':'2xx',code:codes.has(code)?code:'render_failure'};
    const key=JSON.stringify(row);const bucket=buckets.get(minute);const old=bucket.get(key);bucket.set(key,{...row,count:(old?.count||0)+1});
    if(row.code!=='response'||status>=500)emit({event:'publication_response',installation_id:installationId,...row});
    const s=snapshot();if(s.alert&&lastAlert!==minute){lastAlert=minute;emit({event:'publication_alert',installation_id:installationId,code:'crawler_error_rate',requests:s.crawler_requests,errors:s.crawler_errors});}
  }
  return {record,snapshot};
}
