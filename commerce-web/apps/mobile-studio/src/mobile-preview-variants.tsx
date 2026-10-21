import { useEffect, useState } from 'react';
import { mobileApi, type MobileCatalogProduct, type MobilePreviewProductDetail } from '@commerce/api-client';
import { validDeliveryPin, type NativeAddress } from './mobile-native-checkout-model';

export function usePreviewVariants(merchant: string, locale: 'en'|'ar', product: MobileCatalogProduct | undefined, address?: NativeAddress) {
  const configurable = product?.productType === 'configurable';
  const pin = address && validDeliveryPin(address.latitude,address.longitude) ? {latitude:address.latitude,longitude:address.longitude} : undefined;
  const key = JSON.stringify([merchant,locale,product?.id,pin]);
  const [retry,setRetry] = useState(0);
  const [result,setResult] = useState<{key:string; data?:MobilePreviewProductDetail; error?:string}>({key:''});
  const [selection,setSelection] = useState({key:'',id:''});
  useEffect(()=>{
    setSelection({key:'',id:''});
    if (!configurable || !product || !pin) return;
    const controller = new AbortController();
    setResult({key});
    mobileApi.product(merchant,product.id,locale,pin,controller.signal).then(data=>{
      if(controller.signal.aborted)return;
      if(data.merchantId!==merchant || data.locale!==locale || data.product.id!==product.id) throw new Error('Product scope mismatch');
      setResult({key,data});
    }).catch(()=>{if(!controller.signal.aborted)setResult({key,error:locale==='ar'?'تعذر تحميل الخيارات لهذا الموقع. تحقق من العنوان وحاول مرة أخرى.':'Unable to load options for this location. Check the address and try again.'});});
    return ()=>controller.abort();
  },[key,retry,configurable]);
  const current=result.key===key?result:undefined;
  const variants=current?.data?.variants.filter(v=>v.productType!=='configurable') || [];
  const selected=selection.key===key?variants.find(v=>v.id===selection.id && v.inStock):undefined;
  return {configurable,variants,selected,needsLocation:configurable&&(!pin||current?.data?.requiresDeliveryLocation===true),loading:configurable&&!!pin&&!current?.data&&!current?.error,error:current?.error,
    choose:(id:string)=>setSelection({key,id}),retry:()=>{setSelection({key:'',id:''});setRetry(v=>v+1);}, product:current?.data?.product || product};
}

export function PreviewVariants({state,locale,choose,location}:{state:ReturnType<typeof usePreviewVariants>;locale:'en'|'ar';choose:(id:string)=>void;location:()=>void}) {
 const t=(en:string,ar:string)=>locale==='ar'?ar:en;
 if(!state.configurable)return null;
 return <section className="ms-product-variants" aria-label={t('Product options','خيارات المنتج')}><h3>{t('Choose an option','اختر أحد الخيارات')}</h3>
 {state.needsLocation ? <><p>{t('Choose a delivery address to see available sizes and stock.','اختر عنوان توصيل لعرض الأحجام والمخزون المتاح.')}</p><button type="button" onClick={location}>{t('Choose delivery address','اختيار عنوان التوصيل')}</button></> : state.loading ? <p role="status">{t('Loading options…','جارٍ تحميل الخيارات…')}</p> : state.error ? <><p role="alert">{state.error}</p><button type="button" onClick={state.retry}>{t('Retry options','إعادة تحميل الخيارات')}</button></> : <div role="radiogroup" aria-label={t('Choose an option','اختر أحد الخيارات')}>{state.variants.map(v=><button type="button" role="radio" key={v.id} aria-checked={state.selected?.id===v.id} disabled={!v.inStock} onClick={()=>choose(v.id)}>{v.optionLabel || v.name} · {v.price} {v.currency}{!v.inStock&&t(' · Sold out',' · غير متوفر')}</button>)}{!state.variants.length&&<p>{t('No options are available.','لا توجد خيارات متاحة.')}</p>}</div>}
 </section>;
}
