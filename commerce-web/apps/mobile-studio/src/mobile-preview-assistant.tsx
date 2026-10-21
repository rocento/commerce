import { useState } from 'react';
import type { MobileCatalogProduct } from '@commerce/api-client';
import { PreviewProductSheet } from './mobile-preview-sheet';
import { MobilePreviewIcon, type PreviewPlatform } from './mobile-preview-icon';
export function PreviewAssistant({ messages, setMessages, locale, platform, products, openProduct, close, bag }: {
  messages: string[]; setMessages: import('react').Dispatch<import('react').SetStateAction<string[]>>;
  locale: 'en'|'ar'; platform: PreviewPlatform; products: MobileCatalogProduct[];
  openProduct: (product: MobileCatalogProduct) => void; close: () => void; bag: () => void;
}) {
  const t=(en:string,ar:string)=>locale==='ar'?ar:en;
  const [draft,setDraft]=useState(''),[options,setOptions]=useState(false);
  const send=(text:string)=>{if(text.trim()){setMessages(v=>[...v,text.trim()]);setDraft('');}};
  return <PreviewProductSheet platform={platform} locale={locale} title={t('Shopping assistant','مساعد التسوق')} close={close} headerAction={<button type="button" aria-label={t('Chat options','خيارات المحادثة')} aria-expanded={options} onClick={()=>setOptions(v=>!v)}>⋯</button>} footer={<form className="ms-assistant-composer" onSubmit={e=>{e.preventDefault();send(draft);}}><input aria-label={t('Ask your shopping assistant','اسأل مساعد التسوق')} placeholder={t('Ask your shopping assistant…','اسأل مساعد التسوق…')} value={draft} onChange={e=>setDraft(e.target.value)} /><button type="submit" aria-label={t('Send message','إرسال الرسالة')} disabled={!draft.trim()}>↑</button></form>}>
    {options&&<div className="ms-assistant-options"><button type="button" onClick={bag}>{t('View bag','عرض السلة')}</button><button type="button" onClick={()=>{setMessages([]);setOptions(false);}}>{t('New conversation','محادثة جديدة')}</button></div>}
    {!messages.length ? <div className="ms-assistant-welcome"><MobilePreviewIcon name="assistant" platform={platform}/><h2>{t('Find something you’ll love','اعثر على ما يعجبك')}</h2><p>{t('Ask for recommendations, compare products, or get help with your bag.','اطلب توصيات أو قارن المنتجات أو احصل على مساعدة في سلتك.')}</p>{[t('Help me choose a product','ساعدني في اختيار منتج'),t('Show me popular products','اعرض المنتجات الشائعة')].map(text=><button type="button" key={text} onClick={()=>send(text)}>{text}</button>)}</div> : messages.map((message,i)=><div className="ms-assistant-turn" key={i}><p className="ms-assistant-question">{message}</p><p>{t('Preview response · Explore these catalog products.','رد تجريبي · استكشف منتجات الكتالوج التالية.')}</p><div className="ms-assistant-products">{products.slice(0,3).map(product=><button type="button" key={product.id} onClick={()=>openProduct(product)}>{product.imageUrl&&<img src={product.imageUrl} alt=""/>}<strong>{product.name}</strong><span>{product.price} {product.currency}</span></button>)}</div></div>)}
  </PreviewProductSheet>;
}
