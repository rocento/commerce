import { useEffect, useRef, useState } from 'react';
import { merchant } from '../core/commerce';
import { lookupPinAddress } from './addressLookup';
export function usePinAddress(latitude: string, longitude: string, locale: string, onAddress: (address: string) => void) {
  const callback = useRef(onAddress); callback.current = onAddress;
  const [status, setStatus] = useState<'idle'|'loading'|'failed'|'found'>('idle');
  useEffect(() => {
    if (!latitude || !longitude) { setStatus('idle'); return; }
    const abort = new AbortController(); let active = true;
    setStatus('loading'); callback.current('');
    const timeout = setTimeout(() => abort.abort(), 12000);
    const debounce = setTimeout(() => { lookupPinAddress(merchant.origin, latitude, longitude, locale, abort.signal).then(address => {
      if (active) { callback.current(address); setStatus('found'); }
    }).catch(() => { if (active) setStatus('failed'); }); }, 700);
    return () => { active = false; abort.abort(); clearTimeout(debounce); clearTimeout(timeout); };
  }, [latitude, longitude, locale]);
  return status === 'loading' ? (locale === 'ar' ? 'جارٍ العثور على العنوان…' : 'Finding address…') : status === 'failed' ? (locale === 'ar' ? 'تعذر العثور على العنوان. أدخله يدوياً.' : 'Address lookup unavailable. Enter the address manually.') : status === 'found' ? (locale === 'ar' ? 'تحقق من العنوان ثم أكد موقع التوصيل.' : 'Review the address, then confirm your delivery location.') : '';
}
