import { useState, type ReactNode } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { Cart, Locale } from '../core/commerce';
import { Button, Copy } from './Storefront';

export function CouponPanel({ cart, locale, locked, feedback, apply }: {
  cart: Cart | null; locale: Locale; locked: boolean; feedback: ReactNode;
  apply: (code: string) => Promise<void>;
}) {
  const [code, setCode] = useState(cart?.coupon_code ?? '');
  const ar = locale === 'ar';
  const t = (en: string, arabic: string) => ar ? arabic : en;
  return <View style={styles.form}>
    {feedback}
    <Copy>{t('Promo code', 'كود الخصم')}</Copy>
    <TextInput accessibilityLabel={t('Promo code', 'كود الخصم')} value={code} onChangeText={setCode}
      editable={!locked} autoCapitalize="none" autoCorrect={false}
      style={[styles.input, { textAlign: ar ? 'right' : 'left' }]} />
    <Button title={t('Apply code', 'تطبيق الكود')} disabled={locked || !code.trim()}
      onPress={() => void apply(code)} />
    {!!cart?.coupon_error && <Copy accessibilityRole="alert" style={styles.error}>{cart.coupon_error}</Copy>}
    {!!cart?.coupon_code && <>
      <Copy accessibilityLiveRegion="polite">{t('Current code', 'الكود الحالي')}: {cart.coupon_code}</Copy>
      <Button title={t('Remove code', 'إزالة الكود')} secondary disabled={locked}
        onPress={() => { setCode(''); void apply(''); }} />
    </>}
  </View>;
}

const styles = StyleSheet.create({
  form: { gap: 16 },
  input: { minHeight: 48, padding: 12, borderWidth: 1, borderColor: '#DFE3DC', borderRadius: 8, color: '#17251d', backgroundColor: '#FFFFFF', fontSize: 16 },
  error: { color: '#A63125' },
});
