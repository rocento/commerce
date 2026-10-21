import type { CommerceClient } from '../core/commerce';
import { useSyncExternalStore } from 'react';
import { useCommercePanel, type CommercePanelProps } from './useCommercePanel';
import { View } from 'react-native';
import { Button, Copy } from './Storefront';
import { AmountRow, MenuRow } from './ScreenParts';
import { NavigationIcon } from './NavigationIcon';
import { OrderContents } from './OrderContents';
import { ReorderPanel } from './ReorderPanel';

export function OrdersPanel({ runtime, locale, client }: CommercePanelProps & { client: CommerceClient }) {
  const { session, colors, s, t, amount, dateTime, busy, uncertain, assistantBusy, setNotice, setPanel, setTab, setCheckout, act, status, feedback } = useCommercePanel({ runtime, locale });
  const { panel } = useSyncExternalStore(session.navigation.subscribe, session.navigation.getSnapshot, session.navigation.getSnapshot);
  const { orders, detail: order, hasMore: ordersHasMore, detailFailed, selectedID: selectedOrderID } = useSyncExternalStore(session.orders.subscribe, session.orders.getSnapshot, session.orders.getSnapshot);
  const openOrder = (id: string) => act(async () => { setPanel('order'); await session.orders.track(id); }, 'refresh');
  return <>
      {feedback}
      {panel === 'order' && detailFailed && selectedOrderID && <Button title={t('Retry', 'إعادة المحاولة')} disabled={busy} onPress={() => void openOrder(selectedOrderID)} />}
      {panel === 'orders' ? <>
        <Copy style={s.largeTitle}>{t('Your orders', 'طلباتك')}</Copy>
        {!orders.length && <View style={s.emptyState}><NavigationIcon name="bag" color={colors.primary} /><Copy style={s.heading}>{t('No orders yet', 'لا توجد طلبات بعد')}</Copy><Button title={t('Explore the store', 'تصفّح المتجر')} onPress={() => { setPanel(null); setTab('catalog'); }} /></View>}
        {orders.map(value => <View key={value.id} style={s.panelCard}><Copy style={s.productTitle}>{t('Order', 'طلب')} #{value.number}</Copy><Copy style={{ color: colors.primary }}>{status(value.status)}</Copy><Copy style={s.muted}>{dateTime(value.created_at)}</Copy><AmountRow label={t('Total', 'الإجمالي')} value={amount(value.total, value.currency)} /><Button title={t('Track order', 'تتبّع الطلب')} disabled={busy} onPress={() => void openOrder(value.id)} /></View>)}
        {ordersHasMore && !!orders.length && <Button title={t('Load more orders', 'تحميل المزيد من الطلبات')} secondary disabled={busy} onPress={() => void act(async () => { const count = await session.orders.refresh(true); if (!count) setNotice(t('All orders loaded.', 'تم عرض جميع الطلبات.')); }, 'refresh')} />}
      </> : !!order && <>
        <Copy style={s.largeTitle}>{t('Order', 'طلب')} #{order.order.number}</Copy><Copy style={s.muted}>{dateTime(order.order.created_at)}</Copy>
        <View style={[s.panelCard, { backgroundColor: colors.surface }]}><Copy style={s.heading}>{status(order.order.status)}</Copy><AmountRow label={t('Total', 'الإجمالي')} value={amount(order.order.total, order.order.currency)} /></View>
        <OrderContents detail={order} locale={locale} />
        <Button title={t('Get help with this order', 'مساعدة بشأن هذا الطلب')} secondary disabled={busy || uncertain || assistantBusy} onPress={() => { session.support.compose(order.order.id); setPanel('support'); }} />
        <Copy style={s.productTitle}>{t('Order updates', 'تحديثات الطلب')}</Copy>
        {order.history.map(value => <View key={value.id} style={s.timeline}><Copy style={{ color: colors.primary, fontWeight: '600' }}>● {status(value.status)}</Copy><Copy style={s.muted}>{dateTime(value.created_at)}</Copy></View>)}
        <Button title={t('Refresh order', 'تحديث الطلب')} secondary disabled={busy} onPress={() => void openOrder(order.order.id)} />
        <MenuRow title={t('All orders', 'جميع الطلبات')} onPress={() => setPanel('orders')} />
        <ReorderPanel key={order.order.id} order={order.order} session={session} client={client} locale={locale} locked={busy || uncertain || assistantBusy} run={act} checkout={() => { setPanel(null); setTab('bag'); setCheckout(true); }} />
      </>}
      </>;
}
