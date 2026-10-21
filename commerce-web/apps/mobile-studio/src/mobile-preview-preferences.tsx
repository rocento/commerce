import { useState } from 'react';
import { dateTime, orderStatus } from './mobile-native-checkout';
import type { NativeOrder } from './mobile-native-checkout-model';
import './mobile-preview-preferences.css';

export function usePreviewPreferences(merchant: string, platform: string) {
  const key = `rocento:preview-preferences:v1:${merchant}:${platform}`;
  const [value, setValue] = useState<{ updates: boolean; analytics: boolean; read: string[] }>(() => {
    try { const saved = JSON.parse(sessionStorage.getItem(key) || 'null'); if (saved && typeof saved.updates === 'boolean' && Array.isArray(saved.read)) return { updates: saved.updates, analytics: saved.analytics === true, read: saved.read.filter((id: unknown) => typeof id === 'string') }; } catch {}
    return { updates: true, analytics: false, read: [] };
  });
  const update = ({updates, analytics, read}: typeof value) => { const next = {updates, analytics, read}; setValue(next); try { sessionStorage.setItem(key, JSON.stringify(next)); } catch {} };
  return { ...value, update };
}
export function previewNotifications(orders: NativeOrder[]) {
  return orders.flatMap(order => [...order.history.map(event => ({ id: `${order.id}:${event.status}`, order: order.id, status: event.status, date: event.date })), ...(order.cancellation ? [{ id: `${order.id}:cancelled`, order: order.id, status: 'cancelled', date: order.cancellation.date }] : [])]).sort((a,b) => b.date - a.date);
}
type Preferences = ReturnType<typeof usePreviewPreferences>;
export function PreviewPreferences({ screen, platform, locale, setLocale, preferences, orders, back, settings, openOrder, version }: {
  screen: 'notifications' | 'settings'; platform: 'iOS' | 'Android'; locale: 'en' | 'ar';
  setLocale: (locale: 'en' | 'ar') => void;
  preferences: Preferences; orders: NativeOrder[]; back: () => void; settings: () => void; openOrder: (id: string) => void; version: number;
}) {
  const t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  const [filter,setFilter] = useState('all');
  const [refreshed,setRefreshed] = useState(false);
  const events = previewNotifications(orders);
  const unread = events.filter(event => !preferences.read.includes(event.id));
  const mark = (ids: string[]) => preferences.update({ ...preferences, read: [...new Set([...preferences.read,...ids])] });
  return <section className="ms-preferences" aria-label={t(screen === 'settings' ? 'App settings' : 'Notifications', screen === 'settings' ? 'إعدادات التطبيق' : 'الإشعارات')}>
    <button className="ms-preferences-back" onClick={back}>{locale === 'ar' ? '→' : '←'} {t('My account','حسابي')}</button>
    <header className="ms-preferences-intro"><h2>{screen === 'settings' ? t('App settings','إعدادات التطبيق') : t('Notifications','الإشعارات')}</h2></header>
    {screen === 'settings' ? <>
      <div className="ms-preferences-card"><h3>{t('Language','اللغة')}</h3>
        {platform === 'iOS' ? <>
          <label>{t('App language','لغة التطبيق')}<select aria-label={t('App language','لغة التطبيق')} value={locale} onChange={e=>setLocale(e.target.value as 'en'|'ar')}><option value="en">English</option><option value="ar">العربية</option></select></label>
        </> : <>
          <div role="group" aria-label={t('App language','لغة التطبيق')} className="ms-preference-language"><span>{t('App language','لغة التطبيق')}</span><div><button aria-pressed={locale==='en'} onClick={()=>setLocale('en')}>English</button><button aria-pressed={locale==='ar'} onClick={()=>setLocale('ar')}>العربية</button></div></div>
        </>}
      </div>
      <div className="ms-preferences-card"><h3>{t('Notifications','الإشعارات')}</h3><label className="ms-native-toggle"><input type="checkbox" role="switch" checked={preferences.updates} onChange={e=>preferences.update({ ...preferences, updates: e.target.checked })}/><span>{t('Show order updates','عرض تحديثات الطلبات')}</span></label><p>{t('Updates appear when you refresh the inbox. Push notifications are not available.','تظهر التحديثات عند تحديث صندوق الإشعارات. إشعارات الدفع غير متاحة.')}</p></div>
      <div className="ms-preferences-card"><h3>{t('Privacy','الخصوصية')}</h3><label className="ms-native-toggle"><input type="checkbox" role="switch" checked={preferences.analytics} onChange={e=>preferences.update({...preferences,analytics:e.target.checked})}/><span>{t('Share anonymous usage analytics','مشاركة إحصاءات استخدام مجهولة')}</span></label><p>{t('Optional screen and checkout counts. No account, order, search or location details are sent.','إحصاءات اختيارية للشاشات وإتمام الشراء. لا تُرسل بيانات الحساب أو الطلب أو البحث أو الموقع.')}</p></div>
      <p className="ms-preferences-footnote">{t('Preview settings only. No push notifications or analytics are sent.','إعدادات المعاينة فقط. لا تُرسل إشعارات دفع أو بيانات تحليلية.')} · {t('Design version','إصدار التصميم')} {version}</p>
    </> : <>
      <div className="ms-notification-toolbar"><div role="group" aria-label={t('Filter notifications','تصفية الإشعارات')}><button aria-pressed={filter==='all'} onClick={()=>setFilter('all')}>{t('All','الكل')}</button><button aria-pressed={filter==='unread'} onClick={()=>setFilter('unread')}>{t('Unread','غير المقروءة')} ({unread.length})</button></div><button disabled={!preferences.updates || !unread.length} onClick={()=>mark(events.map(e=>e.id))}>{t('Mark all read','تحديد الكل كمقروء')}</button></div>
      {!preferences.updates ? <div className="ms-preferences-card ms-notification-empty"><h3>{t('Order updates are paused','تحديثات الطلبات متوقفة')}</h3><p>{t('Turn on order updates to see your notification inbox.','فعّل تحديثات الطلبات لعرض صندوق الإشعارات.')}</p><button className="ms-cart-primary" onClick={settings}>{t('Notification settings','إعدادات الإشعارات')}</button></div> : !(filter==='unread'?unread:events).length ? <div className="ms-preferences-card ms-notification-empty"><h3>{filter==='unread'?t('You’re all caught up','قرأت كل التحديثات'):t('No updates yet','لا توجد تحديثات بعد')}</h3><p>{t('Updates from your preview orders will appear here.','ستظهر هنا تحديثات طلباتك التجريبية.')}</p></div> : <div className="ms-notification-list">{(filter==='unread'?unread:events).map(event=><button className="ms-notification-card" key={event.id} onClick={()=>{mark([event.id]);openOrder(event.order);}}><span className="ms-notification-dot" data-unread={!preferences.read.includes(event.id)} aria-label={!preferences.read.includes(event.id)?t('Unread','غير مقروء'):t('Read','مقروء')}/><span><strong>{event.status==='cancelled'?t('Order cancelled','تم إلغاء الطلب'):orderStatus(event.status,locale)}</strong><span className="ms-notification-order">{t('Order','طلب')} #{event.order}</span><time dateTime={new Date(event.date).toISOString()}>{dateTime(event.date,locale)}</time><span className="ms-notification-action">{t('View order','عرض الطلب')} {locale==='ar'?'‹':'›'}</span></span></button>)}</div>}
      <button className="ms-preferences-refresh" disabled={!preferences.updates} onClick={()=>setRefreshed(true)}>{t('Refresh updates','تحديث الإشعارات')}</button>
      {refreshed && <p role="status">{t('Updates refreshed','تم تحديث الإشعارات')}</p>}
      <p className="ms-preferences-footnote">{t('Preview inbox · Updates are simulated.','صندوق المعاينة · التحديثات تجريبية.')}</p>
    </>}
  </section>;
}
