import { lookupPinAddress } from './addressLookup';
import { MobileDeliveryMap } from './mobile-delivery-map';
import { useEffect, useRef, useState } from 'react';
import { validDeliveryPin, type NativeAddress, type NativeCheckout } from './mobile-native-checkout-model';
import { checkoutError } from './mobile-native-checkout';
import { MobilePreviewIcon, type PreviewPlatform } from './mobile-preview-icon';
const emptyAddress = ():NativeAddress=>({id:crypto.randomUUID(),latitude:'',longitude:'',street:'',building:'',floor:'',apartment:'',instructions:''});
export function NativeAddressDialog({checkout,locale,platform}: {checkout:NativeCheckout;locale:'en'|'ar';platform:PreviewPlatform}) {
  const t=(en:string,ar:string)=>locale==='ar'?ar:en;
  const [address,setAddress]=useState(()=>checkout.state.addresses.find(a=>a.id===checkout.state.addressId) || emptyAddress()),[locationError,setLocationError]=useState('');
  const [lookupStatus,setLookupStatus]=useState('');
  useEffect(()=>{
    if(!address.latitude||!address.longitude)return;
    const abort=new AbortController();let active=true;
    setLookupStatus(t('Finding address…','جارٍ العثور على العنوان…'));
    const timeout=setTimeout(()=>abort.abort(),12000);
    const timer=setTimeout(()=>{lookupPinAddress('/api',address.latitude,address.longitude,locale,abort.signal).then(street=>{
      if(active){setAddress(a=>a.street?a:{...a,street});setLookupStatus(t('Review the address, then confirm your delivery location.','تحقق من العنوان ثم أكد موقع التوصيل.'));}
    }).catch(()=>{if(active)setLookupStatus(t('Address lookup unavailable. Enter the address manually.','تعذر العثور على العنوان. أدخله يدوياً.'));});},700);
    return()=>{active=false;abort.abort();clearTimeout(timer);clearTimeout(timeout);};
  },[address.latitude,address.longitude,locale]);
  const dialog=useRef<HTMLDialogElement>(null),cancel=useRef<HTMLButtonElement>(null);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    dialog.current?.show();cancel.current?.focus({preventScroll:true});
    return ()=>{if(previous?.isConnected)previous.focus({preventScroll:true});};
  },[]);
  const set=(key:keyof NativeAddress,value:string)=>{setAddress(a=>({...a,[key]:value}));setLocationError('');};
  const validPin=validDeliveryPin(address.latitude,address.longitude);
  const fields = {latitude:t('Latitude','خط العرض'),longitude:t('Longitude','خط الطول'),street:t('Street and address','الشارع والعنوان'),building:t('Building','المبنى'),floor:t('Floor','الطابق'),apartment:t('Apartment','الشقة'),instructions:t('Delivery instructions','تعليمات التوصيل')};
  const saveButton = <button type="submit" className="ms-cart-primary" disabled={!address.street.trim()||!validPin}>{t('Save address','حفظ العنوان')}</button>;
  return <div className={`ms-address-layer ms-address-${platform.toLowerCase()}`}>
    <div className="ms-address-scrim" aria-hidden="true" />
    <dialog ref={dialog} className="ms-native-address-dialog" aria-label={t('Delivery address','عنوان التوصيل')} onCancel={e=>{e.preventDefault();checkout.closeAddress();}} onKeyDown={e=>{
      if(e.key==='Escape'){e.preventDefault();checkout.closeAddress();}
      if(e.key==='Tab'){
        const fields=[...e.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled])')],first=fields[0],last=fields.at(-1);
        if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}
        else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}
      }
    }}>
      <header><div className="ms-address-heading"><span className="ms-address-heading-icon"><MobilePreviewIcon name="location" platform={platform}/></span><div><small>{t('Delivery address','عنوان التوصيل')}</small><h3>{checkout.state.addressId?t('Edit address','تعديل العنوان'):t('Add address','إضافة عنوان')}</h3></div><button type="button" ref={cancel} className="ms-native-text-button" onClick={checkout.closeAddress}>{t('Cancel','إلغاء')}</button></div></header>
      <form className="ms-native-address-form" autoComplete="off" onSubmit={e=>{
        e.preventDefault();
        if(!validPin){setLocationError(t('Choose a valid pin','اختر موقعاً صحيحاً'));return;}
        checkout.saveAddress(address);
      }}>
        <div className="ms-native-address-fields">
          <p>{t('Tap the map or drag the pin to choose your delivery location.','اضغط على الخريطة أو اسحب الدبوس لاختيار موقع التوصيل.')}</p>
          {checkout.state.addresses.length>0 && <section aria-label={t('Saved locations','المواقع المحفوظة')}>{checkout.state.addresses.map(saved=><button type="button" key={saved.id} className="ms-native-text-button" onClick={()=>{checkout.change({selectedAddress:saved.id});checkout.closeAddress();}}>{saved.street}</button>)}</section>}
          <MobileDeliveryMap latitude={address.latitude} longitude={address.longitude} locale={locale} onPin={(latitude,longitude)=>{setAddress(a=>({...a,latitude,longitude,street:""}));setLocationError('');}} />
          {lookupStatus&&<p role="status">{lookupStatus}</p>}
          <fieldset className="ms-address-group"><legend>{t('Address details','تفاصيل العنوان')}</legend><label>{fields.street}<input autoComplete="street-address" maxLength={200} required value={address.street} onChange={e=>set('street',e.target.value)}/></label><p className="ms-address-helper">{t('Street and address are required. Add any details your driver needs below.','الشارع والعنوان مطلوبان. أضف أدناه التفاصيل التي يحتاجها مندوب التوصيل.')}</p>
          <div className="ms-address-detail-grid">{(['building','floor','apartment'] as const).map(key=><label key={key}>{fields[key]}<input maxLength={80} value={address[key]} onChange={e=>set(key,e.target.value)}/></label>)}</div>
          <label>{fields.instructions}<textarea rows={3} maxLength={200} value={address.instructions} onChange={e=>set('instructions',e.target.value)} placeholder={t('Entrance, landmark or delivery notes (optional)','المدخل أو علامة مميزة أو ملاحظات التوصيل (اختياري)')}/></label></fieldset>
          {locationError&&<p className="ms-native-error" role="status">{locationError}</p>}
          {checkout.state.error&&<p role="alert" className="ms-native-error">{checkoutError(checkout.state.error,locale)}</p>}
        </div>
        <footer>{saveButton}</footer>
      </form>
    </dialog>
  </div>;
}
