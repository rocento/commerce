import { useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { ActivityIndicator, TextInput, View } from 'react-native';
import type { ShoppingRuntime } from '../core/shoppingRuntime';
import type { Locale } from '../core/commerce';
import type { Panel, Tab } from '../core/navigationStore';
import { loadingLabel, type OperationKind } from '../core/operations';
import { formatMoney } from '../core/formatMoney';
import { Copy, UiContext } from './Storefront';
import { storefrontStyles } from './storefrontStyles';

export type CommercePanelProps = { runtime: ShoppingRuntime; locale: Locale };

export function useCommercePanel({ runtime, locale }: CommercePanelProps) {
  const { session } = runtime;
  const { colors } = useContext(UiContext);
  const s = useMemo(() => storefrontStyles(colors), [colors]);
  const ar = locale === 'ar';
  const t = (en: string, arabic: string) => ar ? arabic : en;
  const amount = (value: string, currency = 'USD') => formatMoney(value, currency, locale);
  const dateTime = (value: string) => new Date(value).toLocaleString(ar ? 'ar-EG' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' });
  const operationLoading = useSyncExternalStore(session.operations.subscribe, session.operations.getSnapshot, session.operations.getSnapshot);
  const busy = operationLoading.busy;
  useSyncExternalStore(session.checkout.subscribe, session.checkout.getSnapshot, session.checkout.getSnapshot);
  const uncertain = session.checkout.locked;
  const assistantBusy = useSyncExternalStore(session.assistant.subscribe, session.assistant.getBusySnapshot, session.assistant.getBusySnapshot);
  const { failure, notice } = useSyncExternalStore(session.feedback.subscribe, session.feedback.getSnapshot, session.feedback.getSnapshot);
  const error = failure?.message ?? '';
  const setNotice = (value: string) => session.feedback.setNotice(value);
  const setPanel = (panel: Panel) => session.navigation.open(panel);
  const setTab = (tab: Tab) => session.navigation.setTab(tab);
  const setCheckout = (value: boolean) => session.navigation.presentCheckout(value);
  const act = useCallback(async (operation: () => Promise<void>, kind: OperationKind = 'mutation') => {
    await session.perform(operation, kind, locale);
  }, [session, locale]);
  const field = (label: string, value: string, change: (value: string) => void, secret = false, numeric = false) => <View style={s.field}>
    <Copy style={s.label}>{label}</Copy><TextInput accessibilityLabel={label} value={value} onChangeText={change}
      editable={!busy && !uncertain} secureTextEntry={secret} autoCapitalize="none" autoCorrect={false}
      keyboardType={numeric ? 'numbers-and-punctuation' : 'default'}
      style={[s.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background, textAlign: ar ? 'right' : 'left' }]} />
  </View>;
  const status = (value: string) => ({ placed: t('Order placed', 'تم الطلب'), pending: t('Pending', 'قيد الانتظار'), confirmed: t('Confirmed', 'مؤكد'), processing: t('Processing', 'قيد التجهيز'), shipped: t('Shipped', 'تم الشحن'), delivered: t('Delivered', 'تم التوصيل'), cancelled: t('Cancelled', 'ملغي') })[value] ?? value;
  const feedback = <>{busy && <ActivityIndicator accessibilityLabel={loadingLabel(operationLoading, locale)} color={colors.primary} />}{!!error && <Copy accessibilityRole="alert" style={{ color: '#A63125' }}>{error}</Copy>}{!!notice && <Copy accessibilityLiveRegion="polite">{notice}</Copy>}</>;

  return { session, colors, s, ar, t, amount, dateTime, busy, uncertain, assistantBusy, setNotice, setPanel, setTab, setCheckout, act, field, status, feedback };
}
