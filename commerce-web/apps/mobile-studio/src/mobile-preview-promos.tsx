import { useState } from 'react';
import { lineTotal, type CartLine } from './mobile-preview-cart';
import type { NativeCheckout } from './mobile-native-checkout-model';
export type PromoError = 'invalid' | 'expired' | 'minimum' | 'excluded' | 'pickup' | 'empty';
export function previewTotals(lines: CartLine[], method: 'delivery'|'pickup', code: string) {
  const currency=lines[0]?.product.currency || 'USD';
  const scale=10**(new Intl.NumberFormat('en',{style:'currency',currency}).resolvedOptions().maximumFractionDigits ?? 2);
  const units=(n:number)=>Math.round(n*scale);
  const subtotal=lines.reduce((sum,line)=>sum+units(lineTotal(line)),0),baseDelivery=method==='delivery'?5*scale:0;
  let discount=0,deliveryDiscount=0,error:PromoError|null=null;
  if(code) {
    if(!['SAVE10','SAVE5','FREESHIP','MIN50','FULLPRICE10','EXPIRED'].includes(code)) error='invalid';
    else if(code==='EXPIRED') error='expired';
    else if(!lines.length) error='empty';
    else if(code==='FREESHIP' && method==='pickup') error='pickup';
    else if(code==='MIN50' && subtotal<50*scale) error='minimum';
    else if(code==='FREESHIP') deliveryDiscount=baseDelivery;
    else if(code==='SAVE5' || code==='MIN50') discount=Math.min(subtotal,5*scale);
    else {
      const eligible=code==='FULLPRICE10'?lines.filter(l=>!l.product.originalPrice || Number(l.product.originalPrice)<=Number(l.product.price)):lines;
      if(!eligible.length) error='excluded';
      else discount=Math.min(subtotal,Math.round(eligible.reduce((sum,l)=>sum+units(lineTotal(l)),0)/10));
    }
  }
  return {currency,subtotal:subtotal/scale,discount:discount/scale,delivery:(baseDelivery-deliveryDiscount)/scale,deliveryDiscount:deliveryDiscount/scale,tax:0,total:(subtotal-discount+baseDelivery-deliveryDiscount)/scale,error};
}
export function promoMessage(error:PromoError,locale:'en'|'ar') {
  const messages:Record<PromoError,[string,string]>={invalid:['Invalid preview code. Try a code from the demo list.','رمز المعاينة غير صالح. جرّب رمزاً من القائمة التجريبية.'],expired:['This promo code has expired.','انتهت صلاحية رمز الخصم.'],minimum:['MIN50 requires a product subtotal of at least 50 in the cart currency.','يتطلب MIN50 مجموع منتجات لا يقل عن ٥٠ بعملة السلة.'],excluded:['No eligible items. FULLPRICE10 excludes sale products.','لا توجد منتجات مؤهلة. يستثني FULLPRICE10 المنتجات المخفضة.'],pickup:['FREESHIP applies to delivery only. Remove it or choose delivery.','ينطبق FREESHIP على التوصيل فقط. أزله أو اختر التوصيل.'],empty:['Add products before applying a code.','أضف منتجات قبل تطبيق الرمز.']};
  return messages[error][locale==='ar'?1:0];
}
export function PreviewPromos({checkout,locale}:{checkout:NativeCheckout;locale:'en'|'ar'}) {
  const [input,setInput]=useState('');const t=(en:string,ar:string)=>locale==='ar'?ar:en;
  const error=checkout.state.promoAttemptError || checkout.totals.error;
  const money=(n:number)=>new Intl.NumberFormat(locale==='ar'?'ar-EG':'en-US',{style:'currency',currency:checkout.totals.currency}).format(n || 0);
  return <section className="ms-preview-promo" aria-label={t('Promo codes and totals','رموز الخصم والإجماليات')}>
    <h4>{t('Promo code','رمز الخصم')}</h4>
    <form className="ms-checkout-form" onSubmit={e=>{e.preventDefault();checkout.applyPromo(input);}}>
      <label>{t('Enter promo code','أدخل رمز الخصم')}<input maxLength={32} autoComplete="off" value={input} disabled={checkout.state.pending} onChange={e=>setInput(e.target.value)} /></label>
      <button className="ms-native-bordered" type="submit" disabled={checkout.state.pending}>{t('Apply code','تطبيق الرمز')}</button>
    </form>
    {checkout.state.promoCode && <p>{t('Selected code','الرمز المحدد')}: <strong>{checkout.state.promoCode}</strong> <button type="button" disabled={checkout.state.pending} onClick={()=>{checkout.removePromo();setInput('');}}>{t('Remove promo','إزالة الخصم')}</button></p>}
    {error && <p role="alert">{promoMessage(error,locale)}</p>}
    {checkout.state.promoCode && !checkout.totals.error && <p role="status">{t('Promo applied','تم تطبيق الخصم')}: {checkout.state.promoCode}</p>}
    <details><summary>{t('Demo promo codes','رموز الخصم التجريبية')}</summary><p>{t('Preview only. One code per cart. Fixed amounts use the cart currency.','للمعاينة فقط. رمز واحد لكل سلة. المبالغ الثابتة بعملة السلة.')}</p><ul>
      <li>SAVE10 — {t('10% off products','خصم ١٠٪ على المنتجات')}</li><li>SAVE5 — {t('5 off products, capped at subtotal','خصم ٥ على المنتجات بحد أقصى المجموع')}</li><li>FREESHIP — {t('Free delivery','توصيل مجاني')}</li><li>MIN50 — {t('5 off when product subtotal is 50 or more','خصم ٥ عند بلوغ مجموع المنتجات ٥٠')}</li><li>FULLPRICE10 — {t('10% off products that are not on sale','خصم ١٠٪ على المنتجات غير المخفضة')}</li><li>EXPIRED — {t('Expired code test','اختبار رمز منتهي الصلاحية')}</li>
    </ul></details>
    <dl className="ms-review-totals">{[[t('Subtotal','المجموع الفرعي'),checkout.totals.subtotal],[t('Product discount','خصم المنتجات'),-checkout.totals.discount],[t('Delivery savings','توفير التوصيل'),-checkout.totals.deliveryDiscount],[t('Delivery','التوصيل'),checkout.totals.delivery]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{money(Number(value))}</dd></div>)}</dl>
    <strong>{t('Estimated total','الإجمالي التقديري')}: {money(checkout.totals.total)}</strong>
  </section>;
}
