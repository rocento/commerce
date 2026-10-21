import { structuredDataScript } from './structured-data.mjs';
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#x27;'}[c]));
export function finding(code,healthy,resource,evidence,remediation,severity='Error'){return {code,severity:healthy?'Healthy':severity,resource,evidence,remediation:healthy?'No action required.':remediation,observed_at:new Date().toISOString()};}
export function inspectProduct(html,s){
  const out=[];const resource=s.canonical?.url||s.path;
  const visible=html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
  const h1=visible.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1]||'';
  out.push(finding('product_html',!!s.product&&h1.includes(escape(s.product.name)),resource,'Compared the sampled product name with the server-rendered H1.','Restore initial server-visible product content.'));
  const canonical=html.match(/<link\b[^>]*rel="canonical"[^>]*href="([^"]*)"[^>]*>/g)||[];
  out.push(finding('canonical_tag',canonical.length===1&&canonical[0].includes(`href="${escape(s.canonical?.url)}"`),resource,'Expected exactly one canonical matching the approved snapshot URL.','Correct canonical generation and installation binding.'));
  out.push(finding('robots_tag',html.includes(`<meta name="robots" content="${s.robots}"`),resource,'Compared robots meta with effective snapshot policy.','Align HTML robots with effective indexing policy.'));
  let valid=false;try{const scripts=[...html.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)];const actual=JSON.parse(scripts[0]?.[1]||'null');valid=scripts.length===1&&JSON.stringify(actual)===JSON.stringify(s.structured_data);structuredDataScript(s);}catch{valid=false;}
  out.push(finding('structured_data',valid,resource,'Parsed JSON-LD and compared it with snapshot product/offer facts.','Repair structured data and visible product/price consistency.'));
  return out;
}
export async function runHealth({origin,installationId,get,snapshot,observations,redirectPath,imageGet=get}){
  const out=[];const check=async(code,path,verify,fix,transport=get)=>{try{const r=await transport(path);const body=await r.text();const evidence=`HTTP ${r.status}; ${verify(r,body)?'expected representation observed':'representation check failed'}`;out.push(finding(code,verify(r,body),origin.slice(0,-1)+path,evidence,fix));return {r,body};}catch{out.push(finding(code,false,origin.slice(0,-1)+path,'Probe timed out, exceeded the size limit, or transport failed.',fix));return null;}};
  await check('robots','/robots.txt',(r,b)=>r.status===200&&b.includes('User-agent:')&&(!b.includes('Sitemap:')||b.includes(`Sitemap: ${origin}sitemap.xml`)),'Restore robots.txt and its approved-origin sitemap declaration.');
  const map=await check('sitemap','/sitemap.xml',(r,b)=>sitemapValid(b,origin)&&r.status===200,'Restore a valid XML sitemap on the approved origin.');
  if(map?.r.status===200){const path=map.body.match(/<loc>([^<]+)<\/loc>/)?.[1];if(path?.startsWith(origin))await check('sitemap_partition',new URL(path).pathname,(r,b)=>r.status===200&&sitemapValid(b,origin),'Repair the first sampled sitemap partition.');}
  await check('real_404','/products/rocento-health-missing-00000000-0000-0000-0000-000000000000',(r)=>r.status===404,'Return HTTP 404 for missing products instead of an application shell.');
  try{
    const home=await snapshot('/');
    if(home.installation_id!==installationId||home.origin!==origin)throw new Error('binding');
    const product=home.products?.[0];
    if(product){const path=`/products/${product.slug}`;const s=await snapshot(path);if(s.installation_id!==installationId||s.origin!==origin)throw new Error('binding');
      const page=await check('product_response',path,(r)=>r.status===200,'Restore the sampled product response.');if(page){out.push(...inspectProduct(page.body,s));out.push(finding('robots_header',page.r.headers.get('x-robots-tag')===s.robots,origin.slice(0,-1)+path,'Compared response X-Robots-Tag with effective snapshot policy.','Align renderer/proxy robots headers.'));}
      const image=product.image_id&&s.images?.[product.image_id];if(image)await check('public_image',`/api/v1/catalog/media/${image.id}/content`,r=>r.status===200&&/^image\//.test(r.headers.get('content-type')||''),'Restore public image routing, eligibility and storage access.',imageGet);else out.push(finding('public_image',false,origin.slice(0,-1)+path,'No measured image on sampled product.','Approve an accessible product image.','Warning'));
    }else out.push(finding('product_sample',false,origin,'No public product available for a product HTML probe.','Publish a product before checking product HTML.','Warning'));
  }catch{out.push(finding('snapshot_binding',false,origin,'Snapshot unavailable or installation/origin mismatched.','Restore gateway access and correct installation binding.'));}
  if(redirectPath){let path=redirectPath;const visited=new Set();let hops=0;let ok=false;let anomaly=false;try{for(;hops<5;hops++){if(visited.has(path))break;visited.add(path);const r=await get(path);if(![301,302,307,308].includes(r.status)){ok=r.status===200;break;}const next=new URL(r.headers.get('location')||'',origin);if(next.origin!==new URL(origin).origin){anomaly=true;break;}path=next.pathname+next.search;}}catch{/* Evidence below deliberately excludes error bodies. */}out.push(finding('redirect_chain',ok&&hops<=1&&!anomaly,origin.slice(0,-1)+redirectPath,`Observed ${hops} redirect hops; terminal success=${ok}; foreign origin=${anomaly}.`,'Use one approved-host redirect to a live canonical page; remove loops.'));}
  else out.push(finding('redirect_sample',true,origin,'No configured redirect was supplied for sampling.','Review redirect registry when adding redirects.','Warning'));
  const obs=observations.snapshot();out.push(finding('crawler_errors',obs.crawler_requests>0&&!obs.alert,origin,`${obs.crawler_errors} error responses among ${obs.crawler_requests} claimed crawler requests in the process window.`,'Collect crawler observations or investigate 403/429/5xx responses in renderer and CDN logs.',obs.crawler_requests?'Error':'Warning'));
  return {installation_id:installationId,origin,scope:'Local renderer HTTP; one product, one sitemap partition, one image and one configured redirect; not an external CDN audit.',findings:out,observations:obs};
}
export function sitemapValid(body,origin){
  // Validate the deliberately small XML vocabulary generated by this platform.
  if(!body.startsWith('<?xml')||!body.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"')||/<!DOCTYPE|<!ENTITY|<!\[CDATA/.test(body))return false;
  const stripped=body.replace(/^<\?xml[^?]*\?>/, '');const stack=[];let root='';let locations=0;let pos=0;
  for(const match of stripped.matchAll(/<([^>]+)>/g)){
    const text=stripped.slice(pos,match.index);pos=match.index+match[0].length;
    if(text.trim()){
      if(!['loc','lastmod'].includes(stack.at(-1)))return false;
      if(stack.at(-1)==='loc') {try{const u=new URL(text.replaceAll('&amp;','&'));if(u.origin!==new URL(origin).origin||u.username||u.password||u.hash)return false;locations++;}catch{return false;}}
      else if(!/^\d{4}-\d{2}-\d{2}(T[^<]+)?$/.test(text)||!Number.isFinite(Date.parse(text)))return false;
    }
    const close=match[1].startsWith('/');const tag=match[1].replace(/^\//,'').split(/\s/)[0];
    if(!['sitemapindex','urlset','sitemap','url','loc','lastmod'].includes(tag))return false;
    if(close){if(stack.pop()!==tag)return false;}
    else{const parent=stack.at(-1);if(!parent){if(root||!['sitemapindex','urlset'].includes(tag))return false;root=tag;}else if(!({sitemapindex:['sitemap'],urlset:['url'],sitemap:['loc','lastmod'],url:['loc','lastmod']}[parent]||[]).includes(tag))return false;stack.push(tag);}
  }
  return stack.length===0&&locations>0&&!stripped.slice(pos).trim();
}
