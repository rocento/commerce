import { usePinAddress } from './usePinAddress';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import WebView from 'react-native-webview';
import * as Location from 'expo-location';
import { Button, Copy } from './Storefront';
import { locationMapDocument } from './locationMapDocument';

type Props = { latitude: string; longitude: string; locale: string; onAddress: (address: string) => void; onPin: (latitude: string, longitude: string) => void };
export function DeliveryMap({ latitude, longitude, locale, onPin, onAddress }: Props) {
  const addressStatus = usePinAddress(latitude, longitude, locale, onAddress);
  const web = useRef<WebView>(null), alive = useRef(true), request = useRef(0);
  const [ready, setReady] = useState(false), [locating, setLocating] = useState(false), [error, setError] = useState('');
  const t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; }; }, []);
  useEffect(() => {
    if (ready && latitude.trim() && longitude.trim() && Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude)))
      web.current?.injectJavaScript(`window.setDeliveryPin(${Number(latitude)},${Number(longitude)});true;`);
  }, [ready, latitude, longitude]);
  async function locate() {
    const current = ++request.current; setLocating(true); setError('');
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') throw new Error('permission');
      const result = await Promise.race([Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 15000))]);
      if (alive.current && current === request.current) onPin(String(result.coords.latitude), String(result.coords.longitude));
    } catch { if (alive.current && current === request.current) setError(t('Current location is unavailable. Tap the map to choose your pin.', 'الموقع الحالي غير متاح. اضغط على الخريطة لاختيار موقعك.')); }
    finally { if (alive.current && current === request.current) setLocating(false); }
  }
  return <View style={{ gap: 12 }}>
    <Copy>{t('Tap the map or drag the pin to choose your delivery location.', 'اضغط على الخريطة أو اسحب الدبوس لاختيار موقع التوصيل.')}</Copy>
    <View style={{ height: 300, borderRadius: 14, overflow: 'hidden' }}>
      <WebView ref={web} source={{ html: locationMapDocument, baseUrl: 'https://maps.rocento.invalid/' }} applicationNameForUserAgent="RocentoDelivery/1.0" originWhitelist={['https://maps.rocento.invalid']} javaScriptEnabled domStorageEnabled={false} allowFileAccess={false} mixedContentMode="never" scrollEnabled={false}
        onShouldStartLoadWithRequest={r => r.url === 'about:blank' || r.url.startsWith('https://maps.rocento.invalid/')}
        onMessage={event => { try { const p = JSON.parse(event.nativeEvent.data); if(p.type === 'ready') setReady(true); if(p.type === 'pin' && Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && Math.abs(p.latitude) <= 85 && Math.abs(p.longitude) <= 180) { request.current++; setLocating(false); onPin(String(p.latitude), String(p.longitude)); } } catch {} }} />
    </View>
    <Button title={locating ? t('Finding your location…', 'جارٍ تحديد موقعك…') : t('Use current location', 'استخدام الموقع الحالي')} secondary disabled={locating} onPress={() => void locate()} />
    {!!addressStatus && <Copy role="status">{addressStatus}</Copy>}
    {!!error && <Copy accessibilityRole="alert">{error}</Copy>}
    <Copy>{latitude && longitude ? t('Pin selected. You can move it on the map.', 'تم تحديد الموقع. يمكنك تحريك الدبوس على الخريطة.') : t('Choose a pin to continue.', 'اختر موقعاً للمتابعة.')}</Copy>
  </View>;
}
