import { useEffect, useRef, useState } from 'react';
import { mobileApi, type MobileCatalogProduct } from '@commerce/api-client';
import { canCancelOrder, type CancellationReason, type NativeCheckout, type NativeOrder } from './mobile-native-checkout-model';

export function PreviewOrderActions({order,checkout,locale}:{order:NativeOrder;checkout:NativeCheckout;locale:'en'|'ar'}) {
  const t=(en:string,ar:string)=>locale==='ar'?ar:en;
  const [cancelling,setCancelling]=useState(false),[reason,setReason]=useState<CancellationReason|' '>(' '),[prepaid,setPrepaid]=useState(false);
  const [lookup,setLookup]=useState<{loading:boolean;products?:MobileCatalogProduct[];at?:number;error?:boolean}>({loading:false});
  const [notice,setNotice]=useState('');
  const request=useRef<AbortController|null>(null),added=useRef(false);
  useEffect(()=>()=>{request.current?.abort();},[]);
  const money=(price:string|number,currency=order.currency)=>new Intl.NumberFormat(locale==='ar'?'ar-EG':'en-US',{style:'currency',currency}).format(Number(price));
  const reasons: [CancellationReason,string][]=[['changed_mind',t('Changed my mind','غيرت رأيي')],['wrong_items',t('Ordered wrong items','طلبت منتجات خاطئة')],['wrong_address',t('Wrong delivery address','عنوان التوصيل خاطئ')],['other',t('Other reason','سبب آخر')]];
  async function checkProducts() {
    if(checkout.state.pending) return;
    request.current?.abort();const controller=new AbortController();request.current=controller;
    setLookup({loading:true});setNotice('');added.current=false;
    const timeout=window.setTimeout(()=>controller.abort(),30000);
    try {
      const products=new Map<string,MobileCatalogProduct>();let offset=0;
      // Match immutable product IDs, never names; scan fresh catalog pages so renamed items still match.
      for(let page=0;page<50;page++) {
        const data=await mobileApi.searchCatalog(checkout.state.merchant,locale,{q:'',offset,sort:'name_asc'},controller.signal);
        if(data.merchantId!==checkout.state.merchant || data.locale!==locale) throw new Error('Scope mismatch');
        for(const product of data.products) if(order.lines.some(l=>l.product.id===product.id)) products.set(product.id,product);
        if(order.lines.every(l=>products.has(l.product.id)) || data.nextOffset==null) break;
        if(data.nextOffset<=offset) throw new Error('Invalid pagination');
        offset=data.nextOffset;
      }
      if(!controller.signal.aborted && request.current===controller) setLookup({loading:false,products:[...products.values()],at:Date.now()});
      else if(request.current===controller) setLookup({loading:false,error:true});
    } catch { if(request.current===controller) setLookup({loading:false,error:true}); }
    finally {window.clearTimeout(timeout);}
  }
  let currency=checkout.cart.lines[0]?.product.currency;
  const rows=order.lines.map(line=>{
    const product=lookup.products?.find(p=>p.id===line.product.id);
    const existing=checkout.cart.lines.find(l=>l.product.id===line.product.id)?.quantity || 0;
    let issue='';
    if(!product) issue=t('Unavailable or could not be verified','غير متوفر أو تعذر التحقق منه');
    else if(!product.inStock) issue=t('Out of stock','نفد المخزون');
    else if(!Number.isFinite(Number(product.price)) || Number(product.price)<0 || !/^[A-Z]{3}$/.test(product.currency)) issue=t('Price unavailable','السعر غير متوفر');
    else if(currency && currency!==product.currency) issue=t('Different cart currency','عملة مختلفة عن السلة');
    else if(existing>=99) issue=t('Cart quantity limit reached','تم بلوغ الحد الأقصى للكمية');
    if(!issue && product) currency ||= product.currency;
    return {line,product,issue,quantity:issue?0:Math.min(line.quantity,99-existing)};
  });
  const eligible=rows.filter(row=>row.product && !row.issue);
  const cancellation=order.cancellation;
  return <div className="ms-order-actions">
    {cancellation ? <section aria-label={t('Cancellation and refund','الإلغاء والاسترداد')}>
      <h4>{t('Order cancelled','تم إلغاء الطلب')}</h4>
      <p>{reasons.find(([value])=>value===cancellation.reason)?.[1]}</p>
      <small>{new Date(cancellation.date).toLocaleString(locale==='ar'?'ar-EG':'en-US')}</small>
      <p role="status">{cancellation.refund==='not_required'?t('No refund required. Cash on delivery was not collected.','لا يلزم استرداد. لم يتم تحصيل الدفع عند الاستلام.'):cancellation.refund==='pending'?t('Simulated refund pending','الاسترداد التجريبي قيد الانتظار'):cancellation.refund==='failed'?t('Simulated refund failed. You can retry.','فشل الاسترداد التجريبي. يمكنك إعادة المحاولة.'):t('Simulated refund completed','اكتمل الاسترداد التجريبي')}</p>
      {cancellation.prepaid && <p>{t('Test refund amount','مبلغ الاسترداد التجريبي')}: {money(order.total)}<br/>{t('Paid-order simulation only. No money moves.','محاكاة طلب مدفوع فقط. لا يتم تحويل أموال.')}</p>}
      {cancellation.refund==='pending' && <div className="ms-profile-actions"><button type="button" disabled={checkout.state.pending} onClick={()=>checkout.refundOrder(order.id,'refunded')}>{t('Simulate refund success','محاكاة نجاح الاسترداد')}</button><button type="button" disabled={checkout.state.pending} onClick={()=>checkout.refundOrder(order.id,'failed')}>{t('Simulate refund failure','محاكاة فشل الاسترداد')}</button></div>}
      {cancellation.refund==='failed' && <button type="button" disabled={checkout.state.pending} onClick={()=>checkout.refundOrder(order.id,'pending')}>{t('Retry test refund','إعادة محاولة الاسترداد التجريبي')}</button>}
    </section> : canCancelOrder(order) ? cancelling ? <form className="ms-checkout-form" onSubmit={event=>{event.preventDefault();if(reason===' ')return;checkout.cancelOrder(order.id,reason,prepaid);setCancelling(false);}}>
      <label>{t('Cancellation reason','سبب الإلغاء')}<select required value={reason===' '?'':reason} onChange={e=>setReason(e.target.value as CancellationReason)}><option value="">{t('Choose a reason','اختر سبباً')}</option>{reasons.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      <label><input type="checkbox" checked={prepaid} onChange={e=>setPrepaid(e.target.checked)}/>{t('Simulate a paid order to test refunds','محاكاة طلب مدفوع لاختبار الاسترداد')}</label>
      <p className="ms-cart-note">{t('Cancellation is final for this test order. Items are not added back to your cart.','الإلغاء نهائي لهذا الطلب التجريبي. لن تعاد المنتجات للسلة.')}</p>
      <button type="submit" className="ms-cart-primary" disabled={checkout.state.pending || reason===' '}>{t('Confirm cancellation','تأكيد الإلغاء')}</button><button type="button" onClick={()=>setCancelling(false)}>{t('Keep order','الاحتفاظ بالطلب')}</button>
    </form> : <button type="button" className="ms-native-text-button" disabled={checkout.state.pending} onClick={()=>setCancelling(true)}>{t('Cancel test order','إلغاء الطلب التجريبي')}</button> : <p className="ms-cart-note">{t('Cancellation is unavailable after shipment or pickup readiness.','الإلغاء غير متاح بعد الشحن أو التجهيز للاستلام.')}</p>}
    <button type="button" className="ms-cart-primary" disabled={lookup.loading || checkout.state.pending} onClick={checkProducts}>{lookup.loading?t('Checking current catalog…','جارٍ التحقق من الكتالوج الحالي…'):t('Buy again','شراء مرة أخرى')}</button>
    {lookup.error && <p role="alert">{t('Could not check current prices and availability. Nothing was added. Try Buy again.','تعذر التحقق من الأسعار والتوفر الحاليين. لم تتم إضافة شيء. أعد المحاولة.')}</p>}
    {lookup.products && <section aria-label={t('Review reorder','مراجعة إعادة الطلب')}>
      <h4>{t('Current prices and availability','الأسعار والتوفر الحاليان')}</h4>
      {rows.map(({line,product,issue,quantity})=><article key={line.product.id} className="ms-saved-address"><strong>{product?.name || line.product.name}</strong><p>{t('Previously','سابقاً')}: {money(line.product.price)} × {line.quantity}</p>
        {issue ? <p>{issue} · {t('Skipped','تم التخطي')}</p> : <><p>{t('Now','الآن')}: {money(product!.price,product!.currency)} × {quantity}</p>{quantity<line.quantity && <small>{t('Quantity reduced to the cart limit of 99.','تم تقليل الكمية إلى حد السلة البالغ ٩٩.')}</small>}</>}
      </article>)}
      <p className="ms-cart-note">{t('Available items merge with your cart using the checked prices. The original order stays unchanged.','تُضاف المنتجات المتوفرة إلى السلة بالأسعار التي تم التحقق منها. يظل الطلب الأصلي دون تغيير.')}</p>
      {!eligible.length && <p>{t('No items can be added.','لا توجد منتجات يمكن إضافتها.')}</p>}
      <button type="button" className="ms-cart-primary" disabled={!eligible.length || checkout.state.pending} onClick={()=>{
        if(added.current || checkout.state.pending) return;
        if(!lookup.at || Date.now()-lookup.at>60000){setLookup({loading:false});setNotice(t('Prices need another check. Select Buy again.','يلزم التحقق من الأسعار مجدداً. اختر شراء مرة أخرى.'));return;}
        added.current=true;checkout.reorder(eligible.map(row=>({product:row.product!,quantity:row.quantity})));setLookup({loading:false});setNotice(t('Available items added. Open Cart to review your bag.','تمت إضافة المنتجات المتوفرة. افتح السلة لمراجعتها.'));
      }}>{t('Add available items to cart','إضافة المنتجات المتوفرة للسلة')}</button>
    </section>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
