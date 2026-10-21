import { useEffect, useState } from 'react';
import type { MobileCatalogProduct } from '@commerce/api-client';
import { type PreviewPlatform } from './mobile-preview-icon';
import type { NativeAddress } from './mobile-native-checkout-model';
import './mobile-native-wishlist.css';
// Browser-session address shape; retain fields for existing saved preview profiles.
export type Address = { name: string; phone: string; street: string; city: string; country: string; postal: string };
export type SavedAddress = { id: string; label: string; address: Address; native?: NativeAddress };
type Profile = { addresses: SavedAddress[]; defaultId: string; wishlist: MobileCatalogProduct[] };
const empty = (): Profile => ({ addresses: [], defaultId: '', wishlist: [] });
export const blankAddress = (): Address => ({ name: '', phone: '', street: '', city: '', country: '', postal: '' });
export const validAddress = (address: Address) => [address.name,address.phone,address.street,address.city,address.country].every(value => value.trim());
export function usePreviewProfile(merchant: string, platform: string) {
  const key = `rocento:preview-profile:v1:${merchant}:${platform}`;
  const [profile, setProfile] = useState<Profile>(() => {
    try {
      const stored = JSON.parse(sessionStorage.getItem(key) || 'null');
      if (stored && Array.isArray(stored.addresses) && Array.isArray(stored.wishlist) && typeof stored.defaultId === 'string'
        && stored.addresses.every((item: SavedAddress) => typeof item.id === 'string' && typeof item.label === 'string' && item.address && Object.keys(blankAddress()).every(field => typeof item.address[field as keyof Address] === 'string') && (!item.native || ['id','latitude','longitude','street','building','floor','apartment','instructions'].every(field => typeof item.native?.[field as keyof NativeAddress] === 'string')))
        && stored.wishlist.every((p: MobileCatalogProduct) => typeof p.id === 'string' && typeof p.name === 'string' && typeof p.price === 'string' && typeof p.currency === 'string' && typeof p.inStock === 'boolean')) return stored;
    } catch { /* A blocked browser store still permits a temporary preview. */ }
    return empty();
  });
  useEffect(() => { try { sessionStorage.setItem(key, JSON.stringify(profile)); } catch { /* Keep the session working in memory. */ } }, [key,profile]);
  return {
    ...profile,
    defaultAddress: profile.addresses.find(a => a.id === profile.defaultId)?.address,
    saveAddress: (address: Address, label: string, id?: string) => {
      const cleaned = Object.fromEntries(Object.entries(address).map(([k,v])=>[k,v.trim()])) as Address;
      if (!validAddress(cleaned)) return;
      setProfile(current => {
        const existing = id || current.addresses.find(a => JSON.stringify(a.address) === JSON.stringify(cleaned))?.id;
        const native = current.addresses.find(a => a.id === existing)?.native;
        const saved = { id: existing || crypto.randomUUID(), label: label.trim() || cleaned.city, address: cleaned, ...(native ? {native: {...native, street:cleaned.street}} : {}) };
        return { ...current, addresses: existing ? current.addresses.map(a=>a.id===existing?saved:a) : [...current.addresses,saved], defaultId: current.defaultId || saved.id };
      });
    },
    saveNativeAddress: (native: NativeAddress) => setProfile(current => {
      const existing = current.addresses.find(a => a.id === native.id);
      const saved: SavedAddress = { id: native.id, label: existing?.label || native.street, address: { ...(existing?.address || blankAddress()), street: native.street }, native };
      return { ...current, addresses: existing ? current.addresses.map(a => a.id === native.id ? saved : a) : [...current.addresses, saved], defaultId: current.defaultId || native.id };
    }),
    removeAddress: (id: string) => setProfile(current=>{const addresses=current.addresses.filter(a=>a.id!==id);return {...current,addresses,defaultId:current.defaultId===id?addresses[0]?.id || '':current.defaultId};}),
    setDefault: (id: string) => setProfile(current=>({...current,defaultId:id})),
    toggle: (product: MobileCatalogProduct) => setProfile(current=>({...current,wishlist:current.wishlist.some(p=>p.id===product.id)?current.wishlist.filter(p=>p.id!==product.id):[product,...current.wishlist]})),
    clear: () => setProfile(empty()),
  };
}
export type PreviewProfile = ReturnType<typeof usePreviewProfile>;
export function PreviewAddressBook({profile,locale,editNative}:{editNative?:(id:string)=>void;profile:PreviewProfile;locale:'en'|'ar'}) {
  const t=(en:string,ar:string)=>locale==='ar'?ar:en;
  const [editing,setEditing]=useState<string|null>(null),[address,setAddress]=useState(blankAddress),[label,setLabel]=useState(''),[error,setError]=useState(false);
  return <section className="ms-address-book" aria-label={t('Saved addresses','العناوين المحفوظة')}>
    <h3>{t('Saved addresses','العناوين المحفوظة')}</h3>
    <p className="ms-cart-note">{t('Preview data stays in this browser tab, separately for each merchant and device.','تُحفظ بيانات المعاينة في علامة التبويب هذه لكل تاجر وجهاز بشكل منفصل.')}</p>
    {!profile.addresses.length && <div className="ms-address-empty"><strong>{t('No saved addresses yet.','لا توجد عناوين محفوظة بعد.')}</strong><p>{t('Save your delivery details for a smoother checkout.','احفظ تفاصيل التوصيل لإتمام طلباتك بسهولة.')}</p></div>}
    {profile.addresses.map(item=><article className="ms-saved-address" aria-label={item.label} key={item.id}>
      <div className="ms-saved-address-heading"><strong>{item.label}</strong>{profile.defaultId===item.id && <small className="ms-address-default">{t('Default','الافتراضي')}</small>}</div>
      <div className="ms-saved-address-body">{item.address.name && <p>{item.address.name}</p>}<p>{item.address.street}</p>{item.native && <p>{[item.native.building && `${t('Building','المبنى')} ${item.native.building}`,item.native.floor && `${t('Floor','الطابق')} ${item.native.floor}`,item.native.apartment && `${t('Apartment','الشقة')} ${item.native.apartment}`].filter(Boolean).join(' · ')}</p>}{[item.address.city,item.address.country].some(Boolean) && <p>{[item.address.city,item.address.country].filter(Boolean).join(', ')}</p>}{item.address.phone && <p dir="auto">{item.address.phone}</p>}{item.native?.instructions && <p>{item.native.instructions}</p>}</div>
      <div className="ms-profile-actions"><button type="button" onClick={()=>{if(item.native&&editNative){editNative(item.id);return;}setEditing(item.id);setAddress({...item.address});setLabel(item.label);setError(false);}}>{t('Edit address','تعديل العنوان')}</button><button type="button" onClick={()=>{profile.removeAddress(item.id);if(editing===item.id)setEditing(null);}}>{t('Delete address','حذف العنوان')}</button>{profile.defaultId!==item.id && <button type="button" onClick={()=>profile.setDefault(item.id)}>{t('Set as default','تعيين كافتراضي')}</button>}</div>
    </article>)}
    {editing===null ? <button type="button" className="ms-cart-primary" onClick={()=>{setEditing('');setAddress(blankAddress());setLabel('');setError(false);}}>{t('Add delivery address','إضافة عنوان توصيل')}</button> : <form className="ms-checkout-form" autoComplete="off" onSubmit={event=>{event.preventDefault();if(!validAddress(address)||!label.trim()){setError(true);return;}profile.saveAddress(address,label,editing || undefined);setEditing(null);}}>
      <label>{t('Address label','اسم العنوان')}<input required maxLength={60} value={label} onChange={e=>setLabel(e.target.value)} placeholder={t('Home or work','المنزل أو العمل')}/></label>
      {(['name','phone','street','city','country','postal'] as const).map(field=><label key={field}>{({name:t('Full name','الاسم الكامل'),phone:t('Phone number','رقم الهاتف'),street:t('Street and apartment','الشارع والشقة'),city:t('City','المدينة'),country:t('Country','الدولة'),postal:t('Postal code (optional)','الرمز البريدي (اختياري)')})[field]}<input required={field!=='postal'} type={field==='phone'?'tel':'text'} maxLength={field==='street'?200:80} value={address[field]} onChange={e=>setAddress({...address,[field]:e.target.value})}/></label>)}
      {error && <p role="alert">{t('Complete the required address fields.','أكمل حقول العنوان المطلوبة.')}</p>}
      <button type="submit" className="ms-cart-primary">{t('Save address','حفظ العنوان')}</button><button type="button" className="ms-cart-clear" onClick={()=>setEditing(null)}>{t('Cancel','إلغاء')}</button>
    </form>}
  </section>;
}

export function PreviewWishlist({profile,locale,shop,open,currentProducts}:{
  platform:PreviewPlatform;shop:()=>void;profile:PreviewProfile;locale:'en'|'ar';open:(product:MobileCatalogProduct)=>void;
  currentProducts:MobileCatalogProduct[];
}) {
  const t=(en:string,ar:string)=>locale==='ar'?ar:en;
  const [limit,setLimit]=useState(24);
  return <section aria-label={t('Saved products','المنتجات المحفوظة')} className="ms-wishlist-screen ms-native-wishlist">
    <h3>{t('Saved products','المنتجات المحفوظة')}</h3>
    {!profile.wishlist.length && <div className="ms-wishlist-empty"><p>{t('Your wishlist is empty. Save a product from its details.','المفضلة فارغة. احفظ منتجاً من صفحة تفاصيله.')}</p><button type="button" className="ms-cart-primary" onClick={shop}>{t('Explore products','استكشف المنتجات')}</button></div>}
    {!!profile.wishlist.length && <p className="ms-wishlist-count">{profile.wishlist.length} {t('saved products','منتجات محفوظة')}</p>}
    {profile.wishlist.slice(0,limit).map(saved=>{const product=currentProducts.find(p=>p.id===saved.id)||saved;return <article className="ms-wishlist-card" aria-label={product.name} key={product.id}>
      <button type="button" className="ms-cart-product" onClick={()=>open(product)}><span className="ms-wishlist-image">{product.imageUrl?<img src={product.imageUrl} alt="" loading="lazy"/>:<span>{t('No image','لا توجد صورة')}</span>}</span><span><strong>{product.name}</strong><small>{product.price} {product.currency}</small></span></button>
      <p className="ms-wishlist-availability">{product.inStock?t('In stock','متوفر'):t('Out of stock','غير متوفر')}</p>
      <div className="ms-profile-actions"><button type="button" className="ms-cart-primary" onClick={()=>open(product)}>{t('View product','عرض المنتج')}</button><button type="button" onClick={()=>profile.toggle(product)}>{t('Remove from wishlist','إزالة من المفضلة')}</button></div>
    </article>})}
    {profile.wishlist.length>limit && <button type="button" className="ms-native-text-button" onClick={()=>setLimit(v=>v+24)}>{t('Load more products','عرض المزيد من المنتجات')}</button>}
    <p className="ms-cart-note">{t('Preview saves stay in this browser tab, separately for each merchant and device.','تُحفظ اختيارات المعاينة في علامة التبويب هذه لكل تاجر وجهاز بشكل منفصل.')}</p>
  </section>;
}
