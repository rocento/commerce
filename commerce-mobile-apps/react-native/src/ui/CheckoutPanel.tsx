import { useSyncExternalStore } from 'react';
import { useCommercePanel, type CommercePanelProps } from './useCommercePanel';
import { TextInput, View } from 'react-native';
import type { Location } from '../core/commerce';
import { Button, Copy, Row } from './Storefront';
import { AmountRow } from './ScreenParts';

export function CheckoutPanel({ runtime, locale }: CommercePanelProps) {
  const { session, colors, s, ar, t, amount, dateTime, busy, uncertain, assistantBusy, setNotice, setPanel, setTab, setCheckout, act, field, feedback } = useCommercePanel({ runtime, locale });
  const place = () => act(async () => {
    await session.actions.place(() => {
      setCheckout(false); setTab('account'); setPanel('order');
      setNotice(t('Order confirmed', 'تم تأكيد الطلب'));
    });
  });
  const chooseLocation = (value: Location) => act(async () => {
    await session.actions.choose(value);
  });
  const checkoutFlow = session.checkout;
  const { options, windows, quote, giftMessage } = useSyncExternalStore(checkoutFlow.subscribe, checkoutFlow.getSnapshot, checkoutFlow.getSnapshot);
  const { locations, locationID, availability, method, pickup, date, asap } = useSyncExternalStore(session.delivery.subscribe, session.delivery.getSnapshot, session.delivery.getSnapshot);
  const selection = availability?.methods.find(value => value.type === method);
  return <>
      {feedback}
            <>
              <Copy style={s.heading}>{quote ? t('Review your order', 'راجع طلبك') : t('Delivery your way', 'التوصيل كما يناسبك')}</Copy>
              {!uncertain && !quote && <>
                <View style={s.field}><Copy style={s.label}>{t('Gift message (optional)', 'رسالة هدية (اختياري)')}</Copy>
                  <TextInput accessibilityLabel={t('Gift message (optional)', 'رسالة هدية (اختياري)')} value={giftMessage} onChangeText={value => checkoutFlow.setGiftMessage(value)} multiline editable={!busy} style={[s.input, { minHeight: 96, textAlign: ar ? 'right' : 'left', color: colors.text }]} />
                  {!checkoutFlow.giftMessageValid && <Copy accessibilityRole="alert" style={{ color: '#A63125' }}>{t('Please shorten your gift message.', 'يرجى تقصير رسالة الهدية.')}</Copy>}
                </View>
                <Row>{availability?.methods.map(value => <Button key={value.type} title={value.type === 'pickup' ? t('Pickup', 'استلام') : t('Delivery', 'توصيل')} selected={method === value.type} secondary disabled={busy} onPress={() => { session.delivery.update({ method: value.type }); }} />)}</Row>
                {method === 'delivery' && <>
                  <Copy style={s.productTitle}>{t('Delivery address', 'عنوان التوصيل')}</Copy>
                  {locations.map(value => <Button key={value.id} title={value.formatted_address} selected={value.id === locationID} secondary disabled={busy} onPress={() => void chooseLocation(value)} />)}
                  {!locations.length && <Copy>{t('Add an address in Account before continuing.', 'أضف عنواناً في الحساب للمتابعة.')}</Copy>}
                </>}
                {method === 'pickup' && selection?.locations?.map(value => <Button key={value.id} title={value.name} selected={pickup === value.id} secondary disabled={busy} onPress={() => { session.delivery.update({ pickup: value.id }); }} />)}
                {!asap && field(t('Date (YYYY-MM-DD)', 'التاريخ (YYYY-MM-DD)'), date, value => { session.delivery.update({ date: value }); })}
                {selection?.asap && <Row><Button title={t('As soon as possible', 'في أقرب وقت')} secondary selected={asap} disabled={busy} onPress={() => { session.delivery.update({ asap: true }); }} /><Button title={t('Schedule', 'تحديد موعد')} secondary selected={!asap} disabled={busy} onPress={() => { session.delivery.update({ asap: false }); }} /></Row>}
                <Button title={t('Find delivery times', 'عرض المواعيد')} disabled={busy || !selection || (method === 'delivery' ? !locationID : !pickup) || !/^\d{4}-\d{2}-\d{2}$/.test(date)} onPress={() => void act(async () => { await checkoutFlow.findOptions(session.delivery.request); })} />
                {options?.groups.map(group => <View key={group.source_id} style={s.block}><Copy style={s.productTitle}>{group.source_name}</Copy>
                  {group.slots.map(slot => <Button key={`${slot.schedule_id}-${slot.starts_at}`} title={`${dateTime(slot.starts_at)} — ${dateTime(slot.ends_at)}`} secondary disabled={busy || slot.availability !== 'AVAILABLE'} selected={windows[group.source_id]?.starts_at === slot.starts_at} onPress={() => { checkoutFlow.select(group.source_id, slot); }} />)}
                </View>)}
                {!!options && <Button title={t('Review total', 'مراجعة الإجمالي')} disabled={busy || !checkoutFlow.giftMessageValid || (!asap && options.groups.some(group => !windows[group.source_id]))} onPress={() => void act(async () => { await checkoutFlow.review(session.delivery.request); })} />}
              </>}
              {!!quote && <View style={s.block}>
                {!!quote.snapshot.gift_message && <Copy>{t('Gift message: ', 'رسالة الهدية: ')}{quote.snapshot.gift_message}</Copy>}
                <Copy>{locations.find(value => value.id === locationID)?.formatted_address}</Copy>
                {([['subtotal', t('Subtotal', 'المجموع الفرعي')], ['discount_amount', t('Discount', 'الخصم')], ['delivery_fee', t('Delivery', 'التوصيل')], ['tax_amount', t('Tax', 'الضريبة')], ['total', t('Total', 'الإجمالي')]] as const).map(([key, label]) => <AmountRow key={key} label={label} value={amount(quote.snapshot[key], quote.snapshot.currency)} total={key === 'total'} />)}
                <Copy>{t('Payment', 'الدفع')}: {quote.snapshot.payment_method === 'cash_on_delivery' ? t('Cash on delivery', 'الدفع عند الاستلام') : quote.snapshot.payment_method}</Copy>
                <Copy>{t('Expires', 'ينتهي')}: {dateTime(quote.expires_at)}</Copy>
                <Button title={uncertain ? t('Retry previous order', 'إعادة محاولة الطلب السابق') : t('Place order', 'تأكيد الطلب')} disabled={busy} onPress={() => void place()} />
              </View>}
              {!!quote && !uncertain && <Button title={t('Edit delivery', 'تعديل التوصيل')} secondary disabled={busy} onPress={() => checkoutFlow.edit()} />}
              {!uncertain && <Button title={t('Offers & promo codes', 'العروض وأكواد الخصم')} secondary disabled={busy || assistantBusy} onPress={() => { setCheckout(false); setPanel('coupon'); }} />}
              <Button title={t('Back to bag', 'العودة للحقيبة')} secondary disabled={busy} onPress={() => setCheckout(false)} />
            </>
      </>;
}
