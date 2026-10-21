import { useState } from 'react';
import type { NativeOrder } from './mobile-native-checkout-model';
import './mobile-preview-support.css';

export function PreviewSupport({ screen, locale, orders, account, contact }: {
  screen: 'help' | 'contact'; locale: 'en' | 'ar'; orders: NativeOrder[]; account: () => void; contact: () => void;
}) {
  const t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  const [query, setQuery] = useState('');
  const [complete, setComplete] = useState(false);
  const topics = [
    { title: t('Where is my order?', 'أين طلبي؟'), body: t('Open My account, choose an order and view its delivery timeline. In this preview, use Simulate next status to explore delivery updates.', 'افتح حسابي واختر طلباً لعرض مراحل التوصيل. في هذه المعاينة، استخدم محاكاة الحالة التالية لاستكشاف تحديثات التوصيل.') },
    { title: t('How do I change my delivery address?', 'كيف أغير عنوان التوصيل؟'), body: t('Open Saved preview addresses in My account to add or edit an address for a future checkout. Editing a saved address does not change an order already placed.', 'افتح عناوين المعاينة المحفوظة في حسابي لإضافة عنوان أو تعديله لطلب لاحق. تعديل عنوان محفوظ لا يغير طلباً تم إرساله بالفعل.') },
    { title: t('Can I cancel an order?', 'هل يمكنني إلغاء طلب؟'), body: t('Open the order details to check whether cancellation is available for its current status. Review the cancellation and refund information before confirming.', 'افتح تفاصيل الطلب للتحقق من إمكانية الإلغاء حسب حالته الحالية. راجع معلومات الإلغاء والاسترداد قبل التأكيد.') },
    { title: t('How do promo codes work?', 'كيف تعمل رموز الخصم؟'), body: t('Enter a promo code in your bag and select Apply code. Review the updated total and any eligibility message before checkout.', 'أدخل رمز الخصم في حقيبتك واختر تطبيق الرمز. راجع الإجمالي المحدث وأي رسالة تتعلق بشروط العرض قبل إتمام الطلب.') },
    { title: t('How do I change language?', 'كيف أغير اللغة؟'), body: t('Go to My account → App settings to choose English or Arabic for this preview.', 'انتقل إلى حسابي ← إعدادات التطبيق لاختيار الإنجليزية أو العربية لهذه المعاينة.') },
  ];
  const matches = topics.filter(topic => `${topic.title} ${topic.body}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <section className="ms-preferences ms-support" aria-label={screen === 'help' ? t('Help & support','المساعدة والدعم') : t('Contact us','تواصل معنا')}>
    <button type="button" className="ms-preferences-back" onClick={account}>{locale==='ar'?'→':'←'} {t('My account','حسابي')}</button>
    <header className="ms-preferences-intro"><span className="ms-preferences-symbol" aria-hidden="true"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M5 17 3 21l6-3h9a3 3 0 0 0 3-3V6a3 3 0 0 0-3-3H6a3 3 0 0 0-3 3v8a3 3 0 0 0 2 3Z"/><path d="M8 8h8M8 12h5"/></svg></span><h2>{screen==='help'?t('How can we help?','كيف يمكننا مساعدتك؟'):t('Let’s talk','نحن هنا لمساعدتك')}</h2><p>{screen==='help'?t('Find answers and get back to shopping.','اعثر على الإجابات وتابع تسوقك.'):t('Tell us what you need help with.','أخبرنا بما تحتاج المساعدة فيه.')}</p></header>
    {screen==='help' ? <>
      <label className="ms-support-search">{t('Search help','البحث في المساعدة')}<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder={t('Orders, delivery, account…','الطلبات، التوصيل، الحساب…')}/></label>
      <div className="ms-support-quick"><button type="button" onClick={account}><strong>{t('My orders','طلباتي')}</strong><span>{t('Track and manage','متابعة وإدارة')} {locale==='ar'?'‹':'›'}</span></button><button type="button" onClick={contact}><strong>{t('Contact us','تواصل معنا')}</strong><span>{t('Get in touch','تحدث معنا')} {locale==='ar'?'‹':'›'}</span></button></div>
      <h3 className="ms-support-title">{t('Frequently asked questions','الأسئلة الشائعة')}</h3>
      <div className="ms-support-faq">{matches.map(topic=><details key={topic.title}><summary>{topic.title}</summary><p>{topic.body}</p></details>)}</div>
      {!matches.length&&<div className="ms-preferences-card" role="status"><h3>{t('No matching answers','لا توجد إجابات مطابقة')}</h3><p>{t('Try another keyword or open Contact us.','جرّب كلمة أخرى أو افتح تواصل معنا.')}</p><button type="button" className="ms-preferences-back" onClick={()=>setQuery('')}>{t('Clear search','مسح البحث')}</button></div>}
      <div className="ms-preferences-card"><h3>{t('Need a little more help?','هل تحتاج إلى مزيد من المساعدة؟')}</h3><p>{t('Choose a topic and describe your question.','اختر موضوعاً واشرح سؤالك.')}</p><button type="button" className="ms-cart-primary" onClick={contact}>{t('Contact us','تواصل معنا')}</button></div>
    </> : complete ? <div className="ms-preferences-card" role="status"><h3>{t('Preview message complete','اكتملت معاينة الرسالة')}</h3><p>{t('Your form passed validation. This is a demo: no message was sent and no support ticket was created.','تم التحقق من صحة النموذج. هذه تجربة: لم تُرسل رسالة ولم تُنشأ تذكرة دعم.')}</p><button type="button" className="ms-cart-primary" onClick={()=>setComplete(false)}>{t('Start another message','بدء رسالة أخرى')}</button></div> : <>
      <div className="ms-support-demo"><strong>{t('Contact form preview','معاينة نموذج التواصل')}</strong><p>{t('Try the form below. Sending messages is not connected in this preview.','جرّب النموذج أدناه. إرسال الرسائل غير متصل في هذه المعاينة.')}</p></div>
      <form className="ms-preferences-card ms-support-form" onSubmit={e=>{e.preventDefault();setComplete(true);}}>
        <label>{t('Your name','اسمك')}<input required maxLength={100} autoComplete="name" name="name" pattern=".*\S.*"/></label>
        <label>{t('Email address','البريد الإلكتروني')}<input required type="email" maxLength={254} autoComplete="email" name="email" dir="ltr"/></label>
        <label>{t('Topic','الموضوع')}<select required aria-label={t('Topic','الموضوع')} defaultValue=""><option value="" disabled>{t('Choose a topic','اختر موضوعاً')}</option>{['order','delivery','payment','account','other'].map((value,i)=><option key={value} value={value}>{[t('Order enquiry','استفسار عن طلب'),t('Delivery','التوصيل'),t('Payment or refund','الدفع أو الاسترداد'),t('My account','حسابي'),t('Something else','موضوع آخر')][i]}</option>)}</select></label>
        {!!orders.length&&<label>{t('Related order (optional)','الطلب المرتبط (اختياري)')}<select aria-label={t('Related order (optional)','الطلب المرتبط (اختياري)')} defaultValue=""><option value="">{t('No order selected','لم يتم اختيار طلب')}</option>{orders.map(order=><option key={order.id} value={order.id}>#{order.id}</option>)}</select></label>}
        <label>{t('Message','الرسالة')}<textarea required minLength={10} maxLength={2000} rows={5} name="message" placeholder={t('Include the details that will help us understand your question.','أضف التفاصيل التي تساعدنا على فهم سؤالك.')} onChange={e=>e.currentTarget.setCustomValidity(e.currentTarget.value.trim().length<10?t('Please enter at least 10 characters.','يرجى إدخال ١٠ أحرف على الأقل.'):'')}/></label>
        <small>{t('Please do not include passwords or payment card details.','يرجى عدم تضمين كلمات المرور أو بيانات بطاقات الدفع.')}</small>
        <button type="submit" className="ms-cart-primary">{t('Preview message','معاينة الرسالة')}</button>
      </form>
    </>}
  </section>;
}
