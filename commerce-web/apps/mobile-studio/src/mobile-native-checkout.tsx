import { PreviewPromos } from './mobile-preview-promos';
import { PreviewOrderActions } from './mobile-preview-order-actions';
import { useEffect, useRef, useState } from 'react';
import { lineTotal } from './mobile-preview-cart';
import { previewToday, orderStages, validDeliveryPin, type CheckoutError, type CheckoutScenario, type NativeCheckout } from './mobile-native-checkout-model';
import { MobilePreviewIcon, type PreviewPlatform } from './mobile-preview-icon';
import './mobile-native-checkout.css';
import './mobile-native-orders.css';

type Locale = 'en' | 'ar';
export const dateTime = (value: number, locale: Locale) => new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG' : 'en-US', {dateStyle:'long',timeStyle:'short'}).format(value);
const statusLabels: Record<string, [string,string]> = { placed:['Order placed','تم استلام الطلب'],confirmed:['Confirmed','تم تأكيد الطلب'],fulfilling:['Preparing','قيد التجهيز'],shipped:['Shipped','تم الشحن'],out_for_delivery:['Out for delivery','خرج للتوصيل'],delivered:['Delivered','تم التوصيل'],pickup_ready:['Ready for pickup','جاهز للاستلام'],picked_up:['Picked up','تم الاستلام'],cancelled:['Cancelled','تم إلغاء الطلب'],cash_collected:['Payment collected','تم تحصيل المبلغ'],delivery_failed:['Delivery failed','تعذر التوصيل'] };
export const orderStatus = (value: string, locale: Locale) => statusLabels[value]?.[locale === 'ar' ? 1 : 0] || (locale === 'ar' ? 'الحالة غير متاحة' : 'Status unavailable');
export function checkoutError(error: CheckoutError, locale: Locale) {
  const messages: Record<Exclude<CheckoutError,null>,[string,string]> = {
    promo:['Remove the ineligible promo code or update your cart.','أزل رمز الخصم غير المؤهل أو حدّث السلة.'],
    address:['Choose a delivery address.','اختر عنوان التوصيل.'], branch:['Choose a pickup branch.','اختر فرع الاستلام.'], date:['Choose a valid delivery date, today or later.','اختر تاريخ توصيل صحيحاً، اليوم أو بعده.'], slots:['Choose an available time for every fulfillment source.','اختر موعداً متاحاً لكل مصدر تجهيز.'], delivery:['Delivery is unavailable for this address or time. Choose another address or retry.','التوصيل غير متاح لهذا العنوان أو الموعد. اختر عنواناً آخر أو أعد المحاولة.'], stock:['Availability changed. Update your bag before checkout.','تغير التوفر. حدّث الحقيبة قبل إتمام الطلب.'], expired:['Your quote has expired. Check availability and review your order again.','انتهت صلاحية العرض. تحقق من التوفر وراجع طلبك مجدداً.'], pending:['The last result may be pending. Retry confirmation to safely retrieve the same order.','قد تكون نتيجة الطلب معلقة. أعد التأكيد لاسترجاع نفس الطلب بأمان.'], rejected:['Your order could not be confirmed. Check availability and review your order again.','تعذر تأكيد طلبك. تحقق من التوفر وراجع طلبك مجدداً.'], verification:['Verify your account before checkout.','أكد حسابك قبل إتمام الطلب.'],
  };
  return error ? messages[error][locale === 'ar' ? 1 : 0] : '';
}
export function NativeOrderDetail({ checkout, locale }: {checkout:NativeCheckout;locale:Locale}) {
  const [refreshed,setRefreshed]=useState<string|null>(null);
  const order=checkout.detail;
  if (!order) return null;
  const t=(en:string,ar:string)=>locale==='ar'?ar:en;
  const stages = orderStages(order.method);
  const current = order.history.length - 1;
  const complete = current === stages.length - 1;
  const money = (value: number) => new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US', {style:'currency',currency:order.currency}).format(value);
  return <section className="ms-native-order ms-native-order-matched" aria-label={t('Order details','تفاصيل الطلب')}>
    <p className="ms-cart-note">{t('Test order · No real payment or delivery', 'طلب تجريبي · دون دفع أو توصيل حقيقي')}</p>
    <h4>{t('Order','طلب')} #{order.id}</h4>
    <p className="ms-native-order-status" role="status">{orderStatus(order.cancellation ? 'cancelled' : order.history.at(-1)!.status,locale)}</p>
    <small>{t('Ordered on','تاريخ الطلب')}: {dateTime(order.created,locale)}</small>
    <ol className="ms-native-order-history" aria-label={t('Order status history','سجل حالات الطلب')}>
      {order.history.map((entry,i)=><li key={`${entry.date}:${i}`}>{orderStatus(entry.status,locale)} · {dateTime(entry.date,locale)}</li>)}
      {order.cancellation && <li>{orderStatus('cancelled',locale)} · {dateTime(order.cancellation.date,locale)}</li>}
    </ol>
    <button type="button" className="ms-native-text-button ms-refresh-order-status" onClick={()=>setRefreshed(order.id)}>{t('Refresh status','تحديث الحالة')}</button>
    {refreshed===order.id && <p role="status" className="ms-cart-note">{t('Preview status refreshed. Use the preview tools to simulate an update.','تم تحديث حالة المعاينة. استخدم أدوات المعاينة لمحاكاة تحديث.')}</p>}
    <details className="ms-order-preview-tools"><summary>{t('Order preview tools','أدوات معاينة الطلب')}</summary>
    <div className="ms-tracking-journey"><h4>{t('Simulated delivery progress','تقدم التوصيل التجريبي')}</h4>
    <ol className="ms-order-timeline" aria-label={t('Delivery progress','تقدم التوصيل')}>
      {stages.map((stage,i) => <li key={stage} className={i<=current?'is-complete':''} aria-current={!order.cancellation&&i===current?'step':undefined}>
        <span aria-hidden="true">{i<=current?'✓':'○'}</span><div><strong>{orderStatus(stage,locale)}</strong><small>{order.history[i] ? dateTime(order.history[i].date,locale) : order.cancellation ? t('Not reached','لم يتم الوصول') : t('Upcoming','قادم')}</small></div>
      </li>)}
    </ol>
    <p className="ms-cart-note">{order.cancellation ? t('Tracking stopped after cancellation.', 'توقف التتبع بعد الإلغاء.') : t('Simulation: advance one stage at a time to test delivery updates.', 'محاكاة: انتقل مرحلة واحدة كل مرة لاختبار تحديثات التوصيل.')}</p>
    <button type="button" className="ms-cart-primary" disabled={complete || !!order.cancellation} onClick={checkout.refreshStatus}>{order.cancellation?t('Order cancelled','تم إلغاء الطلب'):complete?t('Tracking complete','اكتمل التتبع'):t('Simulate next status','محاكاة الحالة التالية')}</button>
    </div><div className="ms-tracking-delivery"><h4>{order.method==='delivery'?t('Delivery address','عنوان التوصيل'):t('Pickup branch','فرع الاستلام')}</h4>
    {order.address ? <p>{order.address.street}<br/>{[order.address.building,order.address.floor,order.address.apartment].filter(Boolean).join(' · ')}<br/>{order.address.instructions}</p> : <p>{order.branch==='north'?t('Demo north branch','الفرع الشمالي التجريبي'):t('Demo central branch','الفرع المركزي التجريبي')}</p>}
    <p>{order.day ? `${order.day} · ${Object.values(order.windows).join(' / ')}` : t('As soon as possible','في أقرب وقت')}</p>
    </div><div className="ms-tracking-receipt"><h4>{t('Order items','منتجات الطلب')}</h4>
    {order.lines.map(line=><div className="ms-checkout-item" key={line.product.id}><span>{line.product.name} × {line.quantity}</span><strong>{money(lineTotal(line))}</strong></div>)}
    {order.promoCode && <p>{t('Promo code','رمز الخصم')}: {order.promoCode}{!!order.deliveryDiscount && <> · {t('Delivery savings','توفير التوصيل')}: {money(order.deliveryDiscount)}</>}</p>}
    <div className="ms-checkout-summary">
      <div><span>{t('Subtotal','المجموع الفرعي')}</span><strong>{money(order.subtotal)}</strong></div>
      <div><span>{t('Delivery','التوصيل')}</span><strong>{money(order.delivery)}</strong></div>
      <div><span>{t('Discount','الخصم')}</span><strong>{money(order.discount)}</strong></div>
      <div><span>{t('Tax','الضريبة')}</span><strong>{money(order.tax)}</strong></div>
      <div className="ms-checkout-total"><span>{t('Total','الإجمالي')}</span><strong>{money(order.total)}</strong></div>
    </div><p className="ms-tracking-payment">{t('Cash on delivery · Simulated','الدفع عند الاستلام · محاكاة')}</p></div>
    <div className="ms-tracking-actions"><h4>{t('Manage your order','إدارة طلبك')}</h4><PreviewOrderActions key={`${order.id}:${locale}`} order={order} checkout={checkout} locale={locale} /></div></details>
  </section>;
}
export function NativeCheckoutControls({checkout,locale}: {checkout:NativeCheckout;locale:Locale}) {
  const t=(en:string,ar:string)=>locale==='ar'?ar:en;
  const s=checkout.state;
  return <details className="ms-native-checkout-tools"><summary>{t('Checkout preview settings','إعدادات معاينة إتمام الشراء')}</summary>
    <p>{t('Demo addresses, branches, slots and charges. No orders, payments or location requests are sent.','عناوين وفروع ومواعيد ورسوم تجريبية. لا تُرسل طلبات أو مدفوعات أو طلبات موقع.')}</p>
    <label>{t('Test scenario','سيناريو الاختبار')}<select aria-label={t('Test scenario','سيناريو الاختبار')} disabled={s.pending} value={s.scenario} onChange={e=>checkout.selectScenario(e.target.value as CheckoutScenario)}>
      {([['none',t('Successful checkout','إتمام الشراء بنجاح')],['delivery',t('Delivery unavailable','التوصيل غير متاح')],['stock',t('Item goes out of stock','نفاد مخزون منتج')],['expired',t('Quote expires at confirmation','انتهاء العرض عند التأكيد')],['pending',t('Confirmation response lost','فقدان نتيجة التأكيد')],['rejected',t('Order rejected','رفض الطلب')],['verification',t('Account needs verification','الحساب يحتاج تأكيداً')],['location',t('Location permission denied','رفض إذن الموقع')]] as const).map(([value,label])=><option value={value} key={value}>{label}</option>)}
    </select></label>
    {s.scenario === 'stock' && <label>{t('Unavailable item','المنتج غير المتوفر')}<select aria-label={t('Unavailable item','المنتج غير المتوفر')} value={s.stockId} disabled={s.pending} onChange={e=>checkout.selectStockItem(e.target.value)}><option value="">{t('Choose an item','اختر منتجاً')}</option>{checkout.cart.lines.map(line=><option key={line.product.id} value={line.product.id}>{line.product.name}</option>)}</select></label>}
    <label><input type="checkbox" disabled={s.pending} checked={s.split} onChange={e=>checkout.change({split:e.target.checked})}/>{t('Multiple fulfillment sources','مصادر تجهيز متعددة')}</label>
    {s.quote && !s.pending && <button type="button" onClick={checkout.expireQuote}>{t('Expire quote now','إنهاء صلاحية العرض الآن')}</button>}
    {s.scenario !== 'none' && !s.pending && <button type="button" onClick={()=>checkout.selectScenario('none')}>{t('Reset scenario','إعادة تعيين السيناريو')}</button>}
    {s.pending && <p>{t('Resolve the pending confirmation in Cart before changing the session.','أعد تأكيد الطلب المعلق في السلة قبل تغيير الجلسة.')}</p>}
  </details>;
}
export function NativeCartCheckout({ checkout, locale, platform, formatPrice, account, shop }: {
  checkout: NativeCheckout; locale: Locale; platform: PreviewPlatform;
  formatPrice: (price:string,currency:string)=>string; account:()=>void; shop:()=>void;
}) {
  const s=checkout.state,t=(en:string,ar:string)=>locale==='ar'?ar:en;
  const currency=checkout.cart.lines[0]?.product.currency || checkout.detail?.currency || 'USD';
  const money=(n:number)=>formatPrice(String(n),currency);
  const quote=s.quote;
  const reviewRef=useRef<HTMLElement>(null), orderRef=useRef<HTMLDivElement>(null), errorRef=useRef<HTMLParagraphElement>(null);
  useEffect(()=>{ if(quote) reviewRef.current?.scrollIntoView({block:'nearest'}); },[quote?.id]);
  useEffect(()=>{ if(s.confirmed) orderRef.current?.scrollIntoView({block:'start'}); },[s.confirmed]);
  useEffect(()=>{ if(s.error) { errorRef.current?.scrollIntoView({block:'nearest'}); errorRef.current?.focus({preventScroll:true}); } },[s.error]);
  return <section className="ms-native-cart" aria-label={t('Preview cart','سلة المعاينة')}>
    {s.error && <p ref={errorRef} tabIndex={-1} className="ms-native-error" role="alert">{checkoutError(s.error,locale)}{s.error==='verification' && <button type="button" className="ms-native-text-button" onClick={account}>{t('Your account','حسابك')}</button>}</p>}
    {s.confirmed && checkout.detail && !checkout.detail.cancellation && <div ref={orderRef} className="ms-order-confirmation" role="status">
      <span className="ms-confirmation-symbol" aria-hidden="true">✓</span>
      <h3>{t('Your order is confirmed','تم تأكيد طلبك')}</h3>
      <p>{t('Thank you. Your order details are ready below.','شكراً لك. تفاصيل طلبك متاحة أدناه.')}</p>
      <small>{t('Test order · No real payment or delivery','طلب تجريبي · دون دفع أو توصيل حقيقي')}</small>
      <dl><div><dt>{t('Order number','رقم الطلب')}</dt><dd>#{checkout.detail.id}</dd></div><div><dt>{t('Total','الإجمالي')}</dt><dd>{formatPrice(String(checkout.detail.total),checkout.detail.currency)}</dd></div><div><dt>{t('Payment','الدفع')}</dt><dd>{t('Cash on delivery','الدفع عند الاستلام')}</dd></div></dl>
      <button type="button" className="ms-cart-primary" onClick={account}>{t('View order history','عرض سجل الطلبات')}</button>
    </div>}
    <div className="ms-commerce-heading"><span className="ms-account-avatar"><MobilePreviewIcon name="cart" platform={platform}/></span><div><h3>{t('Your bag','حقيبتك')}</h3><p>{t('A few good things, ready for you.','اختيارات مميزة جاهزة لك.')}</p></div></div>
    {checkout.cart.lines.length>0 && <ol className="ms-checkout-progress" aria-label={t('Checkout progress','خطوات إتمام الطلب')}>
      {[t('Bag','الحقيبة'),t('Delivery','الاستلام'),t('Review','المراجعة')].map((label,index)=><li key={index} aria-current={index===(quote?2:1)?'step':undefined}><span aria-hidden="true">{index+1}</span>{label}</li>)}
    </ol>}
    {!checkout.cart.lines.length && <div className="ms-commerce-empty"><h4>{t('Your bag is empty','حقيبتك فارغة')}</h4><p>{t('Discover your next everyday favourites.','اكتشف اختياراتك المفضلة لكل يوم.')}</p><button type="button" className="ms-cart-primary" onClick={shop}>{t('Continue shopping','متابعة التسوق')}</button></div>}
    {checkout.cart.lines.map(line=><article className="ms-native-bag-line" key={line.product.id} aria-label={line.product.name}>
      <div className="ms-bag-product"><div className="ms-bag-thumbnail">{line.product.imageUrl ? <img src={line.product.imageUrl} alt="" loading="lazy"/> : <MobilePreviewIcon name="cart" platform={platform}/>}</div><div><strong>{line.product.name}</strong><small>{formatPrice(line.product.price,line.product.currency)}{line.product.unit && ` / ${line.product.unit}`}</small><p className="ms-bag-price">{money(lineTotal(line))}</p></div></div>
      <div className="ms-native-quantity" role="group" aria-label={t('Quantity','الكمية')}><button type="button" className="ms-native-bordered" disabled={s.pending} aria-label={`${t('Remove one','حذف وحدة')} ${line.product.name}`} onClick={()=>checkout.changeQuantity(line.product.id,line.quantity-1)}><span aria-hidden="true">−</span></button><output aria-label={t('Current quantity','الكمية الحالية')}>{line.quantity}</output><button type="button" className="ms-native-bordered" disabled={s.pending||line.quantity>=99} aria-label={`${t('Add one','إضافة وحدة')} ${line.product.name}`} onClick={()=>checkout.changeQuantity(line.product.id,line.quantity+1)}><span aria-hidden="true">+</span></button></div>
      {(!line.product.inStock || s.scenario==='stock' && s.stockId===line.product.id) && <p className="ms-native-error">{checkoutError('stock',locale)}</p>}
    </article>)}
    {checkout.cart.lines.length>0 && <div className="ms-bag-summary"><strong className="ms-native-subtotal"><span>{t('Subtotal','المجموع الفرعي')}</span><span>{money(checkout.cart.lines.reduce((sum,line)=>sum+lineTotal(line),0))}</span></strong><small>{t('Delivery, discounts and taxes are calculated at review.','تُحسب رسوم التوصيل والخصومات والضرائب عند المراجعة.')}</small></div>}
    {checkout.cart.lines.length>0 && <PreviewPromos checkout={checkout} locale={locale} />}
    {checkout.cart.lines.length>0 && !s.pending && <section className="ms-native-delivery" aria-label={t('Delivery & collection','التوصيل والاستلام')}>
      <div className="ms-commerce-section-title"><span aria-hidden="true">2</span><h4>{t('Delivery & collection','التوصيل والاستلام')}</h4></div>
      <p className="ms-commerce-help">{t('Choose how and when to receive your order.','اختر طريقة وموعد استلام طلبك.')}</p>
      {platform==='iOS' ? <label className="ms-native-picker"><span>{t('Fulfillment','طريقة الاستلام')}</span><select aria-label={t('Fulfillment','طريقة الاستلام')} value={s.method} onChange={e=>checkout.change({method:e.target.value as 'delivery'|'pickup'})}><option value="delivery">{t('Delivery','توصيل')}</option><option value="pickup">{t('Pickup','استلام')}</option></select></label> : <div role="group" aria-label={t('Fulfillment','طريقة الاستلام')}>{(['delivery','pickup'] as const).map(method=><button type="button" className="ms-native-choice" aria-pressed={s.method===method} key={method} onClick={()=>checkout.change({method})}>{s.method===method && <span aria-hidden="true">✓ </span>}{method==='delivery'?t('Delivery','توصيل'):t('Pickup','استلام')}</button>)}</div>}
      {s.method==='pickup' ? platform==='iOS' ? <label className="ms-native-picker">{t('Pickup branch','فرع الاستلام')}<select aria-label={t('Pickup branch','فرع الاستلام')} value={s.branch} onChange={e=>checkout.change({branch:e.target.value})}><option value="">{t('Choose a branch','اختر فرعاً')}</option><option value="central">{t('Demo central branch','الفرع المركزي التجريبي')}</option><option value="north">{t('Demo north branch','الفرع الشمالي التجريبي')}</option></select></label> : <div role="group" aria-label={t('Pickup branch','فرع الاستلام')}>{['central','north'].map(branch=><button type="button" className="ms-native-choice" key={branch} aria-pressed={s.branch===branch} onClick={()=>checkout.change({branch})}>{s.branch===branch && <span aria-hidden="true">✓ </span>}{branch==='central'?t('Demo central branch','الفرع المركزي التجريبي'):t('Demo north branch','الفرع الشمالي التجريبي')}</button>)}</div> : <>
        {s.addresses.map(address=><button type="button" className="ms-native-choice ms-native-address-choice" aria-pressed={s.selectedAddress===address.id} key={address.id} onClick={()=>checkout.change({selectedAddress:address.id})}><span aria-hidden="true">{s.selectedAddress===address.id?'✓':'○'} </span>{address.street}</button>)}
        {s.addresses.some(a=>a.id===s.selectedAddress&&!validDeliveryPin(a.latitude,a.longitude)) && <button type="button" className="ms-native-text-button" onClick={()=>checkout.editAddress(s.selectedAddress)}>{t('Complete delivery pin','أكمل موقع التوصيل')}</button>}
        <button type="button" className="ms-native-text-button" onClick={checkout.openAddress}>{t('Add delivery address','إضافة عنوان توصيل')}</button>
      </>}
      <label className="ms-native-toggle"><input type="checkbox" role="switch" checked={s.asap} onChange={e=>checkout.change({asap:e.target.checked})}/>{t('As soon as possible','في أقرب وقت')}</label>
      {!s.asap && <label className="ms-native-date">{platform==='iOS'?t('Delivery date','تاريخ التوصيل'):t('Delivery date (YYYY-MM-DD)','تاريخ التوصيل (YYYY-MM-DD)')}<input type={platform==='iOS'?'date':'text'} inputMode={platform==='Android'?'numeric':undefined} min={previewToday()} placeholder="YYYY-MM-DD" value={s.day} onChange={e=>checkout.change({day:e.target.value})}/></label>}
      <button type="button" className="ms-native-bordered" disabled={!checkout.stocked} onClick={checkout.checkAvailability}>{t('Check availability','تحقق من التوفر')}</button>
      {s.options && <>
        {s.options.groups.map(group=><div className="ms-native-slots" key={group}><strong>{group==='main'?t('Demo store','المتجر التجريبي'):t('Demo fresh-food source','مصدر المنتجات الطازجة التجريبي')}</strong>
          {!s.asap && ['10:00','14:00'].map(time=><button type="button" className="ms-native-choice" key={time} aria-pressed={s.windows[group]===time} onClick={()=>checkout.selectWindow(group,time)}><span aria-hidden="true">{s.windows[group]===time?'✓':'○'} </span>{dateTime(new Date(`${s.day}T${time}:00`).getTime(),locale)} – {new Intl.DateTimeFormat(locale==='ar'?'ar-EG':'en-US',{hour:'numeric',minute:'2-digit'}).format(new Date(`${s.day}T${String(Number(time.slice(0,2))+2)}:00:00`))}</button>)}
        </div>)}
        <button type="button" className="ms-cart-primary" onClick={checkout.review}>{t('Review order','مراجعة الطلب')}</button>
      </>}
    </section>}
    {quote && <section ref={reviewRef} className="ms-native-quote" aria-label={t('Review your order','راجع طلبك')}>
      <div className="ms-commerce-section-title"><span aria-hidden="true">3</span><h3>{t('Review your order','راجع طلبك')}</h3></div>
      <p className="ms-commerce-help">{t('Check your total before confirming.','راجع الإجمالي قبل تأكيد الطلب.')}</p>
      <dl className="ms-review-totals">{[[t('Subtotal','المجموع الفرعي'),quote.subtotal],[t('Discount','الخصم'),quote.discount],[t('Delivery','التوصيل'),quote.delivery],[t('Tax','الضريبة'),quote.tax]].map(([label,value])=><div key={label}><dt>{label}</dt><dd>{money(Number(value))}</dd></div>)}</dl>
      {quote.promoCode && <p>{t('Promo code','رمز الخصم')}: {quote.promoCode}{!!quote.deliveryDiscount && <> · {t('Delivery savings','توفير التوصيل')}: {money(quote.deliveryDiscount)}</>}</p>}
      <strong className="ms-native-quote-total">{t('Total','الإجمالي')}: {formatPrice(String(quote.total),quote.currency)}</strong><div className="ms-payment-method"><small>{t('Payment method','طريقة الدفع')}</small><p>{t('Cash on delivery','الدفع عند الاستلام')}</p></div>
      <small>{t('Quote expires','ينتهي العرض')}: {dateTime(quote.expires,locale)}</small>
      {checkout.expired && <p className="ms-native-error" role="alert">{checkoutError('expired',locale)}</p>}
      {s.pending && <p>{checkoutError('pending',locale)}</p>}
      <button type="button" className="ms-cart-primary" onClick={checkout.place}>{s.pending?t('Retry confirmation','إعادة التأكيد'):t('Place order','تأكيد الطلب')}</button>
    </section>}
    {checkout.detail && <div ref={s.confirmed ? undefined : orderRef}><NativeOrderDetail checkout={checkout} locale={locale}/></div>}
  </section>;
}
