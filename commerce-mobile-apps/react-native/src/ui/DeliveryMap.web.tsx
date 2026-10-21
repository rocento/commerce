import { usePinAddress } from './usePinAddress';
import { useEffect, useRef, useState } from 'react';
import { locationMapDocument } from './locationMapDocument';
type Props = { latitude: string; longitude: string; locale: string; onAddress: (address: string) => void; onPin: (latitude: string, longitude: string) => void };
export function DeliveryMap({latitude,longitude,locale,onPin,onAddress}:Props) {
  const addressStatus = usePinAddress(latitude, longitude, locale, onAddress);
  const frame=useRef<HTMLIFrameElement>(null),[error,setError]=useState('');
  const t=(en:string,ar:string)=>locale==='ar'?ar:en;
  useEffect(()=>{const receive=(e:MessageEvent)=>{if(e.source!==frame.current?.contentWindow)return;const p=e.data;if(p?.type==='pin'&&Number.isFinite(p.latitude)&&Number.isFinite(p.longitude)&&Math.abs(p.latitude)<=85&&Math.abs(p.longitude)<=180)onPin(String(p.latitude),String(p.longitude));};window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive);},[onPin]);
  useEffect(()=>{if(latitude&&longitude)frame.current?.contentWindow?.postMessage({type:'set-pin',latitude:Number(latitude),longitude:Number(longitude)},window.location.origin);},[latitude,longitude]);
  return <div><p>{t('Tap the map or drag the pin to choose your delivery location.','اضغط على الخريطة أو اسحب الدبوس لاختيار موقع التوصيل.')}</p><iframe ref={frame} title={t('Delivery map','خريطة التوصيل')} srcDoc={locationMapDocument} style={{width:'100%',height:300,border:0,borderRadius:14}}/><button type="button" onClick={()=>{if(!navigator.geolocation){setError(t('Location unavailable. Choose a pin on the map.','الموقع غير متاح. اختر موقعك على الخريطة.'));return;}navigator.geolocation.getCurrentPosition(p=>onPin(String(p.coords.latitude),String(p.coords.longitude)),()=>setError(t('Location unavailable. Choose a pin on the map.','الموقع غير متاح. اختر موقعك على الخريطة.')),{timeout:15000});}}>{t('Use current location','استخدام الموقع الحالي')}</button>{addressStatus&&<p role="status">{addressStatus}</p>}{error&&<p role="alert">{error}</p>}</div>;
}
