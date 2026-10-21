import { useSyncExternalStore } from 'react';
import { useCommercePanel, type CommercePanelProps } from './useCommercePanel';
import { View } from 'react-native';
import type { Location } from '../core/commerce';
import { Button, Copy } from './Storefront';
import { DeliveryNeighborhood } from './DeliveryNeighborhood';
import { DeliveryMap } from './DeliveryMap';

export function AddressPanel({ runtime, locale }: CommercePanelProps) {
  const { session, colors, s, t, busy, uncertain, setNotice, setPanel, act, field, feedback } = useCommercePanel({ runtime, locale });
  const { panel } = useSyncExternalStore(session.navigation.subscribe, session.navigation.getSnapshot, session.navigation.getSnapshot);
  const { customer } = useSyncExternalStore(session.account.subscribe, session.account.getSnapshot, session.account.getSnapshot);
  const { locations, locationID, addressDraft } = useSyncExternalStore(session.delivery.subscribe, session.delivery.getSnapshot, session.delivery.getSnapshot);
  const { address, latitude, longitude, building, floor, apartment, instructions } = addressDraft;
  const setAddress = (address: string) => session.delivery.editAddress({ address });
  const setBuilding = (building: string) => session.delivery.editAddress({ building });
  const setFloor = (floor: string) => session.delivery.editAddress({ floor });
  const setApartment = (apartment: string) => session.delivery.editAddress({ apartment });
  const setInstructions = (instructions: string) => session.delivery.editAddress({ instructions });
  const chooseLocation = (value: Location) => act(async () => {
    await session.actions.choose(value);
  });
  const saveAddress = () => act(async () => {
    await session.actions.saveAddress();
    setNotice(t('Delivery location selected', 'تم اختيار موقع التوصيل')); setPanel(null);
  });
  return <>
      {feedback}
      {panel === 'addresses' ? <>
        <Copy style={s.largeTitle}>{t('Your addresses', 'عناوينك')}</Copy><Copy style={s.muted}>{t('Choose where your everyday essentials arrive.', 'اختر مكان توصيل احتياجاتك اليومية.')}</Copy>
        {locations.map(value => <View key={value.id} style={[s.panelCard, value.id === locationID && { borderColor: colors.primary }]}><Copy style={s.productTitle}>{value.label === 'home' ? t('Home', 'المنزل') : value.label}</Copy><Copy>{value.formatted_address}</Copy><Button title={value.id === locationID ? t('Selected address', 'العنوان المحدد') : t('Deliver here', 'التوصيل هنا')} secondary selected={value.id === locationID} disabled={busy || uncertain} onPress={() => void chooseLocation(value)} /></View>)}
        {!locations.length && <Copy>{t('No saved addresses yet.', 'لا توجد عناوين محفوظة بعد.')}</Copy>}
        <Button title={t('Add delivery address', 'إضافة عنوان توصيل')} disabled={uncertain} onPress={() => setPanel('address')} />
      </> : <>{locations.map(value => <Button key={value.id} title={value.formatted_address} secondary disabled={busy || uncertain} onPress={() => void act(async () => { await session.actions.choose(value); setPanel(null); })} />)}<Copy style={s.muted}>{t('Choose how to set your location', 'اختر طريقة تحديد موقعك')}</Copy>
              <View style={{ flexDirection: 'row', gap: 8 }}>{(['pin', 'neighborhood'] as const).map(method => <Button key={method} title={method === 'pin' ? t('Map pin', 'دبوس الخريطة') : t('Manual address', 'إدخال العنوان يدوياً')} secondary selected={addressDraft.locationMethod === method} disabled={busy || uncertain} onPress={() => { if (method !== addressDraft.locationMethod) session.delivery.editAddress({ locationMethod: method, geography: null, latitude: '', longitude: '' }); }} />)}</View>
              {addressDraft.locationMethod === 'neighborhood' ? <DeliveryNeighborhood locale={locale} draft={addressDraft} edit={change => session.delivery.editAddress(change)} /> :
              <DeliveryMap latitude={latitude} longitude={longitude} locale={locale} onAddress={value=>{ if (!session.delivery.getSnapshot().addressDraft.address) session.delivery.editAddress({address:value}); }} onPin={(latitude,longitude)=>session.delivery.editAddress({latitude,longitude,address:""})} />}
              {field(t('Street address', 'عنوان الشارع'), address, setAddress)}
              {field(t('Building', 'المبنى'), building, setBuilding)}{field(t('Floor', 'الطابق'), floor, setFloor)}{field(t('Apartment', 'الشقة'), apartment, setApartment)}
              {field(t('Delivery instructions', 'تعليمات التوصيل'), instructions, setInstructions)}
              <Button title={customer ? t('Save address', 'حفظ العنوان') : t('Use this location', 'استخدم هذا الموقع')} disabled={busy || uncertain || !address.trim() || !latitude || !longitude} onPress={() => void saveAddress()} />
      </>}
      </>;
}
