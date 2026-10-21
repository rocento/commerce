import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { interfaceTranslationsApi } from '@commerce/api-client';
import { Notice } from '@commerce/ui';

export function InterfaceStorefrontPreview({close}:{close:()=>void}) {
  const frame=useRef<HTMLIFrameElement>(null);
  const [channel]=useState(()=>crypto.randomUUID());
  const [device,setDevice]=useState('desktop');
  const [generation,setGeneration]=useState(0);
  const query=useQuery({queryKey:['interface-authorized-preview',generation],queryFn:interfaceTranslationsApi.get,staleTime:0,gcTime:0,retry:false});
  const target=useMemo(()=>{
    try{const url=new URL(import.meta.env.VITE_STOREFRONT_URL||`${window.location.protocol}//${window.location.hostname}:5173`);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;url.pathname='/';url.search='';url.hash='';url.searchParams.set('interface_preview','ar');url.searchParams.set('interface_parent',window.location.origin);url.searchParams.set('interface_channel',channel);return url;}catch{return null;}
  },[channel]);
  useEffect(()=>{
    if(!target||!query.data)return;
    const receive=(event:MessageEvent)=>{if(event.source!==frame.current?.contentWindow||event.origin!==target.origin||event.data?.type!=='rocento:interface-preview-ready'||event.data?.channel!==channel)return;frame.current.contentWindow?.postMessage({type:'rocento:interface-preview-bundle',channel,bundle:query.data},target.origin);};
    window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);
  },[query.data,target,channel]);
  return <section><h2>Storefront interface preview</h2><p>Preview saved interface translations while browsing, managing your cart and reviewing checkout. Product/category content is managed separately. Order placement is disabled.</p><div className="language-actions"><button className="secondary" onClick={()=>setDevice(device==='desktop'?'mobile':'desktop')}>{device==='desktop'?'Mobile size':'Desktop size'}</button><button className="secondary" onClick={()=>setGeneration(n=>n+1)}>Reload saved translations</button><button className="secondary" onClick={close}>Close preview</button></div>
    {!target?<Notice error>Set a valid storefront URL before previewing.</Notice>:query.isPending?<p role="status">Loading authorized preview…</p>:query.error?<Notice error>{query.error.message}</Notice>:<iframe key={generation} ref={frame} title="Storefront interface preview" src={target.href} className={`interface-storefront-preview ${device}`} onLoad={()=>frame.current?.contentWindow?.postMessage({type:'rocento:interface-preview-bundle',channel,bundle:query.data},target.origin)}/>}
  </section>;
}
