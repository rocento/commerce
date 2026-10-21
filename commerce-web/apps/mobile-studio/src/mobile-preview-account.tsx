import { useRef, useState } from 'react';
import { NativeAuth } from './mobile-native-auth';
import { PreviewAddressBook, type PreviewProfile } from './mobile-preview-profile';
import { NativeOrderDetail, dateTime, orderStatus } from './mobile-native-checkout';
import type { NativeCheckout } from './mobile-native-checkout-model';
import { MobilePreviewIcon, type PreviewPlatform } from './mobile-preview-icon';

export function PreviewAccount({ shop, initialScreen = "home", wishlistEnabled, openInformation, openHelp, openContact, openSettings, openNotifications, locale, platform, signedIn, setSignedIn, configVersion, showConnection, profile, openWishlist, checkout, customerIdentifier, setCustomerIdentifier }: {
  shop: () => void;
  initialScreen?: 'home'|'orders'|'addresses';
  openInformation: (screen: 'about'|'privacy'|'terms') => void; openHelp: () => void; openContact: () => void; openSettings: () => void; openNotifications: () => void;
  customerIdentifier: string; setCustomerIdentifier: (identifier:string)=>void;
  wishlistEnabled: boolean; profile: PreviewProfile; openWishlist: () => void;
  checkout: NativeCheckout; formatPrice: (price: string, currency: string) => string;
  locale: 'en' | 'ar'; platform: PreviewPlatform; signedIn: boolean;
  setSignedIn: (value: boolean) => void; configVersion: number; showConnection: boolean;
}) {
  const t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  const orderDetailRef = useRef<HTMLDivElement>(null);
  const [verificationCode,setVerificationCode]=useState('');
  const [verificationError,setVerificationError]=useState(false);
  const [screen,setScreen]=useState<'home'|'orders'|'addresses'>(initialScreen);
  const [notice, setNotice] = useState('');
  return <section className="ms-native-account" data-account-screen={screen} aria-label={t('Your account', 'حسابك')}>

    {screen !== 'home' && <button type="button" className="ms-native-text-button" onClick={()=>setScreen('home')}>{t('‹ My account','حسابي ›')}</button>}
    {screen === 'home' && <div className="ms-account-heading"><h2 className="ms-account-title">{t('My account','حسابي')}</h2><button type="button" aria-label={t("Open notifications","فتح الإشعارات")} onClick={openNotifications}><MobilePreviewIcon name="notifications" platform={platform}/></button></div>}
    {signedIn ? <>
      {screen === 'home' && <><div className="ms-account-identity"><span className="ms-account-avatar"><MobilePreviewIcon platform={platform} name="account" /></span><div><span>{t('Welcome back','مرحباً بعودتك')}</span><p>{customerIdentifier}</p><small>{checkout.state.verified?t('Verified account','حساب مؤكد'):t('Verification needed','مطلوب تأكيد الحساب')}</small></div></div><div className="ms-account-shortcuts"><button type="button" onClick={()=>setScreen('orders')}><MobilePreviewIcon name="cart" platform={platform}/><strong>{t('Orders','الطلبات')}</strong><small>{t('View all','عرض الكل')}</small></button>{wishlistEnabled&&<button type="button" onClick={openWishlist}><MobilePreviewIcon name="wishlist" platform={platform}/><strong>{t('Wishlist','المفضلة')}</strong><small>{t('Saved items','المحفوظات')}</small></button>}<button type="button" onClick={()=>setScreen('addresses')}><MobilePreviewIcon name="location" platform={platform}/><strong>{t('Addresses','العناوين')}</strong><small>{profile.addresses.length} {t('saved','محفوظة')}</small></button></div>
      <div className="ms-account-latest"><h3>{t('Latest order','أحدث طلب')}</h3><button type="button" onClick={()=>setScreen('orders')}>{t('View all','عرض الكل')}</button></div>{checkout.state.orders.length ? <button type="button" className="ms-native-text-button" onClick={()=>setScreen('orders')}>#{checkout.state.orders[0].id} · {orderStatus(checkout.state.orders[0].history.at(-1)!.status,locale)}</button> : <div className="ms-account-empty"><strong>{t('No orders yet','لا توجد طلبات بعد')}</strong><p>{t('Your orders and delivery updates will appear here.','ستظهر طلباتك وتحديثات التوصيل هنا.')}</p><button type="button" className="ms-native-text-button" onClick={shop}>{t('Explore products','استكشف المنتجات')}</button></div>}</>}

      {!checkout.state.verified && <><p>{t('Verify your account before checkout', 'أكد حسابك قبل إتمام الطلب')}</p><label>{t('Verification code', 'رمز التحقق')}<input placeholder="000000" autoComplete="off" value={verificationCode} onChange={e=>{setVerificationCode(e.target.value);setVerificationError(false);}} /></label><button type="button" className="ms-native-text-button" onClick={() => setNotice(t('Demo code: 000000. No message was sent.', 'الرمز التجريبي: 000000. لم يتم إرسال رسالة.'))}>{t('Send verification code', 'إرسال رمز التحقق')}</button><button type="button" className="ms-cart-primary" onClick={()=>{if(!verificationCode.trim()){setVerificationError(true);return;}checkout.verify();setVerificationCode('');setVerificationError(false);}}>{t('Verify', 'تأكيد')}</button>{verificationError&&<p role="alert">{t('Enter the verification code you received.','أدخل رمز التحقق الذي تلقيته.')}</p>}</>}
      {screen === 'addresses' && <><h2>{t('Addresses','العناوين')}</h2>
      <button type="button" className="ms-native-text-button ms-account-add-address" disabled={checkout.state.pending} onClick={checkout.openAddress}>{t('Add delivery address', 'إضافة عنوان توصيل')}</button>
      <details className="ms-saved-address-disclosure"><summary>{t('Saved preview addresses', 'عناوين المعاينة المحفوظة')}</summary><fieldset disabled={checkout.state.pending} style={{border:0,padding:0,margin:0}}><PreviewAddressBook profile={profile} locale={locale} editNative={checkout.editAddress} /></fieldset></details>
      </>}
      {screen === 'orders' && <>
      <h3>{t('Your orders', 'طلباتك')}</h3><p className="ms-cart-note">{t('Test orders stay in this tab for this merchant and device. Open an order to follow its simulated delivery.', 'تُحفظ الطلبات التجريبية في هذه العلامة لهذا التاجر والجهاز. افتح طلباً لمتابعة توصيله التجريبي.')}</p>{!checkout.state.orders.length && <div className="ms-account-empty"><strong>{t('No orders yet', 'لا توجد طلبات بعد')}</strong><p>{t('Your orders and delivery updates will appear here.', 'ستظهر طلباتك وتحديثات التوصيل هنا.')}</p></div>}
      <div className="ms-order-history-list">{checkout.state.orders.map(order => <button type="button" className="ms-native-text-button ms-native-order-link" key={order.id} aria-pressed={checkout.detail?.id===order.id} onClick={() => {checkout.selectOrder(order.id);requestAnimationFrame(()=>orderDetailRef.current?.scrollIntoView({block:'start'}));}}>
        <span>#{order.id} · {orderStatus(order.cancellation ? 'cancelled' : order.history.at(-1)!.status, locale)}</span>
        <small>{dateTime(order.created,locale)}</small>
        <span>{order.total.toFixed(2)} {order.currency}</span>
      </button>)}</div>
      <div ref={orderDetailRef} className="ms-order-history-detail"><NativeOrderDetail checkout={checkout} locale={locale} /></div>
      <button type="button" className="ms-native-text-button" onClick={() => setNotice(checkout.state.orders.length ? t('Demo orders refreshed.', 'تم تحديث الطلبات التجريبية.') : t('No orders in this demo session.', 'لا توجد طلبات في الجلسة التجريبية.'))}>{t('Refresh orders', 'تحديث الطلبات')}</button>
      </>}
      {screen === 'home' && <>
    <h4 className="ms-account-preferences-label">{t("PREFERENCES","التفضيلات")}</h4><div className="ms-account-preferences"><button type="button" className="ms-native-text-button" onClick={openSettings}>{t("Language","اللغة")}<span>{locale==='ar'?'العربية':'English'} ›</span></button><button type="button" className="ms-native-text-button" onClick={openNotifications}>{t("Notifications","الإشعارات")}</button><button type="button" className="ms-native-text-button" onClick={openSettings}>{t("App settings","إعدادات التطبيق")}</button><button type="button" className="ms-native-text-button" onClick={openHelp}>{t("Help & support","المساعدة والدعم")}</button><button type="button" className="ms-native-text-button" onClick={openContact}>{t("Contact us","تواصل معنا")}</button></div>
      <button type="button" className="ms-native-text-button" disabled={checkout.state.pending} onClick={() => {profile.clear();checkout.clearOrders();checkout.reset();setNotice(t('Saved preview data cleared.', 'تم حذف بيانات المعاينة المحفوظة.'));}}>{t('Clear saved preview data', 'حذف بيانات المعاينة المحفوظة')}</button>
      <button type="button" className="ms-native-text-button" onClick={() => { setSignedIn(false); setScreen('home'); setNotice(''); }}>{t('Sign out', 'تسجيل الخروج')}</button>
      </>}
    </> : <NativeAuth locale={locale} platform={platform} onSignIn={identifier=>{setCustomerIdentifier(identifier);setSignedIn(true);setNotice('');}} />}
    {screen === 'home' && <nav className="ms-information-links ms-account-information" aria-label={t('Store information','معلومات المتجر')}><button type="button" onClick={()=>openInformation('about')}>{t('About us','من نحن')}<span aria-hidden="true">{locale==='ar'?'‹':'›'}</span></button><button type="button" onClick={()=>openInformation('privacy')}>{t('Privacy policy','سياسة الخصوصية')}<span aria-hidden="true">{locale==='ar'?'‹':'›'}</span></button><button type="button" onClick={()=>openInformation('terms')}>{t('Terms & conditions','الشروط والأحكام')}<span aria-hidden="true">{locale==='ar'?'‹':'›'}</span></button></nav>}
    {showConnection && screen === 'home' && <details className="ms-native-connection"><summary>{t('App connection', 'ربط التطبيق')}</summary><p>{t('Published design version', 'إصدار التصميم المنشور')} {configVersion}</p><label>{t('One-time connection code', 'رمز الربط لمرة واحدة')}<input type="password" disabled placeholder={t('Available in the installed app', 'متاح في التطبيق المثبت')} /></label><button type="button" disabled>{t('Connect app', 'ربط التطبيق')}</button></details>}
    {notice && <p role="status">{notice}</p>}

  </section>;
}
