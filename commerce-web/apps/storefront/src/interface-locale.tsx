import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { formatInterfaceMessage, interfaceTranslationsApi, languagesApi, validThemeLocale, type InterfaceBundle, type InterfaceLocale } from '@commerce/api-client';
import { parseInterfacePreview, receiveInterfacePreview } from './interface-preview';
import catalog from './interface-messages.json';
import { readShopperLocale, saveShopperLocale, shopperLocale, SHOPPER_LOCALE_KEY } from './shopper-locale';

import './interface-locale.css';

const publishedBundle = parseInterfacePreview({revision: 1, catalog_version: `bundled-${catalog.version}`, messages: catalog.messages.map(message => ({plural: null, ...message})), overrides: []});

export type Translate=(key:string,fallback:string,parameters?:Record<string,string|number>)=>string;
const fallback:Translate=(_key,text,parameters={})=>text.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g,(token,key:string)=>Object.hasOwn(parameters,key)?String(parameters[key]):token);
const Context=createContext<{locale:string;direction:'ltr'|'rtl';preview:boolean;setLocale:(locale:string)=>void;t:Translate;message:(text:string)=>string}>({message:text=>text,locale:'en',direction:'ltr',preview:false,setLocale:()=>{},t:fallback});
export const useInterface=()=>useContext(Context);

export function interfaceTranslator(bundle: InterfaceBundle, locale: string): Translate {
  return (key,text,values={})=>{
    const source=bundle.messages.some(message=>message.key===key)?bundle:publishedBundle;
    if(source.messages.some(message=>message.key===key)) {
      try{return formatInterfaceMessage(source,key,locale.split('-')[0]==='ar'?'ar':'en',values);}catch{/* Preserve usable copy if a phrase is incomplete. */}
    }
    return fallback(key,text,values);
  };
}

/** Published documents use the same phrases as the shopping app, including SSR. */
export function PublicInterfaceProvider({children,locale,initialBundle}:{children:ReactNode;locale:string;initialBundle?:unknown}) {
  const [bundle,setBundle]=useState(()=>{
    try{return initialBundle ? parseInterfacePreview(initialBundle) : publishedBundle;}catch{return publishedBundle;}
  });
  useEffect(()=>{
    const controller=new AbortController();
    const refresh=()=>{void interfaceTranslationsApi.public(controller.signal).then(value=>{
      if(!controller.signal.aborted)setBundle(parseInterfacePreview(value));
    }).catch(()=>{/* Retain the last validated bundle during an outage. */});};
    refresh();
    const timer=window.setInterval(refresh,5000);
    window.addEventListener('focus',refresh);
    return()=>{controller.abort();window.clearInterval(timer);window.removeEventListener('focus',refresh);};
  },[]);
  const t=useMemo(()=>interfaceTranslator(bundle,locale),[bundle,locale]);
  const context=useMemo(()=>({locale,direction:locale.split('-')[0]==='ar'?'rtl' as const:'ltr' as const,preview:false,setLocale:()=>{},t,message:(text:string)=>{
    const source=[...bundle.messages,...publishedBundle.messages].find(message=>!message.plural&&message.en.other===text);
    return source?t(source.key,text):text;
  }}),[bundle,locale,t]);
  return <Context.Provider value={context}>{children}</Context.Provider>;
}

/** Saved admin copy refreshes on storefront routes; paired previews stay isolated. */
export function InterfaceProvider({children}:{children:ReactNode}) {
  const location=useLocation(),navigate=useNavigate();
  const [parameters]=useState(()=>new URLSearchParams(window.location.search));
  const requested=parameters.has('interface_preview');
  const [preferredLocale,updateLocale]=useState<string>(()=>requested ? shopperLocale(parameters.get('interface_preview')) : validThemeLocale(parameters.get('lang') || '') ? parameters.get('lang')! : readShopperLocale());
  const languages = useQuery({queryKey:['public-languages'],queryFn:languagesApi.public,enabled:!requested});
  const available = useMemo(() => languages.data ? [languages.data.source_locale,...languages.data.languages.map(language=>language.locale).filter(locale=>locale!==languages.data?.source_locale)] : ['en','ar'], [languages.data]);
  useEffect(()=>{if(!requested && languages.data && !parameters.has('lang')) updateLocale(readShopperLocale([languages.data.source_locale,...languages.data.languages.map(language=>language.locale)]));},[requested,languages.data,parameters]);
  // Shopping assistance is English-only during this rollout; preserve the
  // shopper preference for the other storefront routes.
  const assistantPage=location.pathname.replace(/\/$/, '') === '/assistant';
  const locale=assistantPage ? 'en' : shopperLocale(preferredLocale, requested ? ['en','ar'] : available);
  const direction = languages.data?.languages.find(language=>language.locale===locale)?.direction ?? (locale.split('-')[0]==='ar'?'rtl':'ltr');
  const setLocale=useCallback((next:string)=>{updateLocale(next);if(!requested)saveShopperLocale(next);},[requested]);
  useEffect(()=>{
    if(requested)return;
    const changed=(event:StorageEvent)=>{if(event.key===SHOPPER_LOCALE_KEY||event.key===null)updateLocale(readShopperLocale(available));};
    window.addEventListener('storage',changed);
    return()=>window.removeEventListener('storage',changed);
  },[requested,available]);
  const [bundle,setBundle]=useState<InterfaceBundle|null>(requested ? null : publishedBundle),[error,setError]=useState('');
  const savedTranslations = useQuery({
    queryKey: ['storefront-interface-translations'],
    queryFn: async ({signal}) => parseInterfacePreview(await interfaceTranslationsApi.public(signal)),
    enabled: !requested,
    staleTime: 0,
    refetchInterval: 5000,
    refetchOnWindowFocus: 'always',
  });
  useEffect(()=>{if(!requested && savedTranslations.data)setBundle(savedTranslations.data);},[requested,savedTranslations.data]);
  const refreshTranslations=savedTranslations.refetch;
  useEffect(()=>{if(!requested)void refreshTranslations();},[requested,location.pathname,refreshTranslations]);
  useEffect(()=>{
    if(!requested)return;
    const controller=new AbortController();
    void receiveInterfacePreview(parameters.get('interface_parent')||'',parameters.get('interface_channel')||'',controller.signal).then(value=>{if(!controller.signal.aborted)setBundle(value);}).catch(e=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'Preview unavailable');});
    return ()=>controller.abort();
  },[parameters,requested]);
  useEffect(()=>{
    if(!requested||!bundle)return;
    const next=new URLSearchParams(location.search);
    next.set('interface_preview',locale);next.set('interface_parent',parameters.get('interface_parent')||'');next.set('interface_channel',parameters.get('interface_channel')||'');
    if(next.toString()!==location.search.slice(1))navigate({pathname:location.pathname,search:`?${next}`,hash:location.hash},{replace:true,state:location.state});
  },[requested,bundle,locale,location,parameters,navigate]);
  useLayoutEffect(()=>{
    const html=document.documentElement,oldLang=html.getAttribute('lang');
    html.setAttribute('lang',locale);
    const robots=requested?document.createElement('meta'):null;
    if(robots){robots.name='robots';robots.content='noindex, nofollow';document.head.append(robots);}
    return()=>{if(oldLang===null)html.removeAttribute('lang');else html.setAttribute('lang',oldLang);robots?.remove();};
  },[requested,locale]);
  const translate=useMemo(()=>bundle?interfaceTranslator(bundle,locale):fallback,[bundle,locale]);
  useEffect(()=>{
    if(!bundle)return;
    const changed=new Set<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>();
    const control=(target:EventTarget|null)=>target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement?target:null;
    const clear=(event:Event)=>{const input=control(event.target);if(input&&changed.has(input)){input.setCustomValidity('');changed.delete(input);}};
    const invalid=(event:Event)=>{
      const input=control(event.target);if(!input)return;
      if(changed.has(input))input.setCustomValidity('');
      // Preserve custom business validation supplied by the field itself.
      if(input.validity.customError)return;
      const message=input.validity.valueMissing?translate('validation.required','This field is required'):
        input instanceof HTMLInputElement&&input.type==='email'&&input.validity.typeMismatch?translate('validation.email','Enter a valid email address'):
        input instanceof HTMLInputElement&&input.validity.rangeUnderflow?translate('validation.range_minimum','Enter a value of at least {minimum}.',{minimum:Number(input.min)}):
        input instanceof HTMLInputElement&&input.validity.rangeOverflow?translate('validation.range_maximum','Enter a value no greater than {maximum}.',{maximum:Number(input.max)}):
        input instanceof HTMLInputElement&&input.validity.stepMismatch?translate('validation.step','Enter a valid quantity.'):
        (input instanceof HTMLInputElement||input instanceof HTMLTextAreaElement)&&input.validity.tooShort?translate('validation.minimum','Enter at least {minimum} characters',{minimum:input.minLength}):translate('validation.invalid','Please enter a valid value.');
      input.setCustomValidity(message);changed.add(input);
    };
    document.addEventListener('invalid',invalid,true);document.addEventListener('input',clear,true);document.addEventListener('change',clear,true);
    return()=>{document.removeEventListener('invalid',invalid,true);document.removeEventListener('input',clear,true);document.removeEventListener('change',clear,true);changed.forEach(input=>input.setCustomValidity(''));};
  },[bundle,locale,translate]);
  const sourceMessages=useMemo(()=>new Map([...publishedBundle.messages,...(bundle?.messages||[])].filter(m=>!m.plural).map(m=>[m.en.other,m.key])),[bundle]);
  const message=useCallback((text:string)=>{
    const translateSource=(source:string)=>{const key=sourceMessages.get(source);return key?translate(key,source):source;};
    const prefix="Couldn't update this item. ";
    return text.startsWith(prefix)?translateSource(prefix.trim())+' '+translateSource(text.slice(prefix.length)):translateSource(text);
  },[sourceMessages,translate]);
  const context=useMemo(()=>({locale,direction,setLocale,preview:requested,t:translate,message}),[locale,direction,setLocale,requested,translate,message]);
  if(requested&&!bundle)return <main className="interface-preview-gate"><h1>{error?'Preview unavailable':'Loading language preview…'}</h1>{error&&<p role="alert">{error}</p>}</main>;
  return <Context.Provider value={context}>{requested&&!assistantPage&&<aside className="interface-preview-banner" aria-label="Interface preview controls" dir="ltr"><strong>Interface translation preview</strong><label>Preview language <select value={locale} onChange={e=>setLocale(e.target.value as InterfaceLocale)}><option value="en">English</option><option value="ar">العربية</option></select></label><span>Cart and address changes use your shopping session. Order placement is disabled.</span></aside>}{children}</Context.Provider>;
}


export function LanguageSwitcher() {
  const {locale,setLocale}=useInterface();
  const languages = useQuery({queryKey:['public-languages'],queryFn:languagesApi.public});
  const options = languages.data ? languages.data.languages : [{locale:'en',native_name:'English'},{locale:'ar',native_name:'العربية'}];
  const location=useLocation();
  if(location.pathname.replace(/\/$/, '') === '/assistant')return null;
  return <label className="shopper-language-switcher" dir="ltr">
    <span className="sr-only">{locale==='ar'?'اللغة':'Language'}</span>
    <select aria-label="Language / اللغة" value={locale} onChange={event=>setLocale(event.target.value)}>
      {languages.data && !options.some(language=>language.locale===languages.data?.source_locale) && <option value={languages.data.source_locale}>{languages.data.source_locale}</option>}
      {options.map(language=><option key={language.locale} value={language.locale} lang={language.locale}>{language.native_name}</option>)}
    </select>
  </label>;
}
