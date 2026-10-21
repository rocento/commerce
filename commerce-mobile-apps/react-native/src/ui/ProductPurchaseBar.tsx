import { useContext, useState } from 'react';
import { Pressable, View } from 'react-native';
import type { LiveProduct, Locale } from '../core/commerce';
import { Button, Copy, Row, UiContext } from './Storefront';
import { ProductPrice } from './DiscoveryScreens';
export function ProductPurchaseBar({ product, locale, quantity, onQuantity, locked, ready, hasAddress, onAdd, onAddress, showsDraftQuantity = false }: { product: LiveProduct; locale: Locale; showsDraftQuantity?: boolean; quantity: number; onQuantity: (value: number) => void; locked: boolean; ready: boolean; hasAddress: boolean; onAdd: (quantity: number) => void; onAddress: () => void }) {
  const { colors } = useContext(UiContext), t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  const [draftQuantity, setDraftQuantity] = useState(1);
  const shownQuantity = quantity || draftQuantity;
  const changeQuantity = (value: number) => quantity > 0 ? onQuantity(value) : setDraftQuantity(Math.max(1, Math.min(99, value)));
  return <View style={{ gap: 12 }}>
    <Row><View style={{ flex: 1, gap: 4 }}><Copy style={{ fontSize: 12, color: colors.muted }}>{t('Price per item', 'سعر القطعة')}</Copy><ProductPrice product={product} locale={locale} /></View>
      {(quantity > 0 || showsDraftQuantity) && <View style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}><Row>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Decrease quantity', 'تقليل الكمية')} disabled={locked} onPress={() => changeQuantity(shownQuantity - 1)} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: locked ? .4 : 1 }}><Copy>−</Copy></Pressable>
        <Copy accessibilityLabel={t('Quantity', 'الكمية')} accessibilityLiveRegion="polite" style={{ minWidth: 24, textAlign: 'center' }}>{shownQuantity}</Copy>
        <Pressable accessibilityRole="button" accessibilityLabel={t('Increase quantity', 'زيادة الكمية')} disabled={locked || (hasAddress && ready && !product.in_stock) || shownQuantity >= 99} onPress={() => changeQuantity(shownQuantity + 1)} style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', opacity: shownQuantity >= 99 ? .4 : 1 }}><Copy>+</Copy></Pressable>
      </Row></View>}
    </Row>
    {quantity === 0 && <Button title={!hasAddress ? t('Add to cart', 'إضافة إلى السلة') : !ready ? t('Select an option above', 'اختر أحد الخيارات أعلاه') : product.in_stock ? t('Add to cart', 'إضافة إلى السلة') : t('Out of stock', 'غير متوفر')} disabled={locked || (hasAddress && (!ready || !product.in_stock))} onPress={hasAddress ? () => onAdd(draftQuantity) : onAddress} />}
  </View>;
}
