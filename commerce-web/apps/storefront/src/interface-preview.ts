import type { InterfaceBundle, InterfaceMessage, InterfaceOverride } from '@commerce/api-client';

const forms = ['zero','one','two','few','many','other'];
const object = (v: unknown): v is Record<string,unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const placeholders = (s: string) => [...new Set(s.match(/\{[A-Za-z_][A-Za-z0-9_]*\}/g)||[])].sort().join('|');
/** Accept only bounded text data; stale overrides fall back to the current built-in phrase. */
export function parseInterfacePreview(value: unknown): InterfaceBundle {
  if (!object(value) || !Number.isInteger(value.revision) || Number(value.revision)<1 || typeof value.catalog_version!=='string' || value.catalog_version.length>128 || !Array.isArray(value.messages) || value.messages.length>2000 || !Array.isArray(value.overrides) || value.overrides.length>10000) throw new Error('Invalid interface preview data');
  const keys=new Set<string>();
  const messages: InterfaceMessage[]=value.messages.map(m=>{
    if(!object(m)||typeof m.key!=='string'||!/^[a-z][a-z0-9_.]{0,150}$/.test(m.key)||keys.has(m.key)||typeof m.group!=='string'||!(m.plural===null||typeof m.plural==='string'&&/^[a-z_]+$/.test(m.plural)))throw new Error('Invalid interface message');
    keys.add(m.key);
    for(const locale of ['en','ar']) {
      const map=m[locale];if(!object(map)||!Object.hasOwn(map,'other'))throw new Error('Invalid interface forms');
      for(const [form,text] of Object.entries(map))if(!forms.includes(form)||typeof text!=='string'||text.length>16000)throw new Error('Invalid interface text');
    }
    return m as unknown as InterfaceMessage;
  });
  const overrides:InterfaceOverride[]=[];
  for(const o of value.overrides){
    if(!object(o)||typeof o.key!=='string'||!['en','ar'].includes(String(o.locale))||!forms.includes(String(o.form))||typeof o.text!=='string'||o.text.length>16000)throw new Error('Invalid interface override');
    const message=messages.find(m=>m.key===o.key);
    const source=message?.[o.locale as 'en'|'ar'][o.form as keyof InterfaceMessage['en']];
    if(source!==undefined && o.source_text===source && placeholders(o.text)===placeholders(source))overrides.push(o as unknown as InterfaceOverride);
  }
  return {revision:Number(value.revision),catalog_version:value.catalog_version,messages,overrides};
}

export function receiveInterfacePreview(parentOrigin:string,channel:string,signal:AbortSignal):Promise<InterfaceBundle> {
  return new Promise((resolve,reject)=>{
    if(window.parent===window||!channel||channel.length>100){reject(new Error('Open this preview from Storefront languages in admin.'));return;}
    let origin:string;
    try {const url=new URL(parentOrigin);if(!['http:','https:'].includes(url.protocol)||url.origin!==parentOrigin)throw new Error();origin=url.origin;}catch{reject(new Error('Invalid interface preview parent. Reopen the preview from admin.'));return;}
    const cleanup=()=>{clearTimeout(timeout);window.removeEventListener('message',receive);signal.removeEventListener('abort',abort);};
    const abort=()=>{cleanup();reject(new DOMException('Preview cancelled','AbortError'));};
    const receive=(event:MessageEvent)=>{
      if(event.source!==window.parent||event.origin!==origin||event.data?.type!=='rocento:interface-preview-bundle'||event.data?.channel!==channel)return;
      cleanup();try{resolve(parseInterfacePreview(event.data.bundle));}catch(e){reject(e);}
    };
    const timeout=window.setTimeout(()=>{cleanup();reject(new Error('The admin preview did not respond. Reopen it from admin.'));},15000);
    window.addEventListener('message',receive);signal.addEventListener('abort',abort,{once:true});
    if(signal.aborted){abort();return;}
    window.parent.postMessage({type:'rocento:interface-preview-ready',channel},origin);
  });
}
