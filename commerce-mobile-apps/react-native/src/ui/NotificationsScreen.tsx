import type { OperationKind } from '../core/operations';
import { useEffect, useSyncExternalStore } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { NotificationsStore } from '../core/notificationsStore';
import type { Locale } from '../core/commerce';
import { Button, Copy, Row } from './Storefront';
export function NotificationsScreen({ store, owner, locale, run, locked, status, openOrder, signIn }: {
  store: NotificationsStore; owner?: string; locale: Locale; run: (operation: () => Promise<void>, kind?: OperationKind) => Promise<void>;
  locked: boolean; status: (value: string) => string; openOrder: (id: string) => void; signIn: () => void;
}) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const t = (en: string, ar: string) => locale === 'ar' ? ar : en;
  useEffect(() => { void run(async () => { await store.bind(owner ?? null); if (owner) await store.refresh(owner); }, 'refresh'); }, [store, owner]);
  const events = state.unreadOnly ? store.unread : store.events;
  return <View style={{ gap: 16 }}>
    <Copy accessibilityRole="header" style={{ fontSize: 24, fontWeight: '700' }}>{t('Order updates', 'تحديثات الطلب')}</Copy>
    <Button title={state.enabled ? t('Pause order updates', 'إيقاف تحديثات الطلبات') : t('Enable order updates', 'تفعيل تحديثات الطلبات')} secondary disabled={locked || !state.ready} onPress={() => void run(async () => { const enabled = !state.enabled; await store.setEnabled(enabled); if (enabled && owner) await store.refresh(owner); })} />
    {!owner ? <><Copy>{t('Sign in to see order updates', 'سجّل الدخول لعرض تحديثات الطلبات')}</Copy><Button title={t('Sign in', 'تسجيل الدخول')} onPress={signIn} /></> : <>
      <Row><Button title={t('All', 'الكل')} secondary selected={!state.unreadOnly} onPress={() => store.filterUnread(false)} /><Button title={`${t('Unread', 'غير المقروءة')} (${store.unread.length})`} secondary selected={state.unreadOnly} onPress={() => store.filterUnread(true)} /></Row>
      <Button title={t('Mark all read', 'تحديد الكل كمقروء')} secondary disabled={locked || !state.enabled || !store.unread.length} onPress={() => void run(() => store.mark(store.events.map(value => value.id)))} />
      {state.loading && <ActivityIndicator />}
      {state.failed && <Copy accessibilityRole="alert">{t('Unable to load updates. Please retry.', 'تعذر تحميل التحديثات. حاول مجدداً.')}</Copy>}
      {!state.enabled ? <Copy>{t('Order updates are paused', 'تحديثات الطلبات متوقفة')}</Copy> : <>
        {state.loaded && !events.length && <Copy>{state.unreadOnly ? t('You’re all caught up', 'قرأت كل التحديثات') : t('No updates yet', 'لا توجد تحديثات بعد')}</Copy>}
        {events.map(event => <View key={event.id} style={{ gap: 8 }}>
          <Copy>{state.read.includes(event.id) ? '○' : '●'} {status(event.status)}</Copy><Copy>{t('Order', 'طلب')} #{event.number}</Copy>
          <Copy>{new Date(event.date).toLocaleString(locale === 'ar' ? 'ar-EG' : 'en-US')}</Copy>
          <Button title={t('View order', 'عرض الطلب')} secondary disabled={locked} onPress={() => void run(async () => { await store.mark([event.id]); }).then(() => { if (store.getSnapshot().owner === owner) openOrder(event.order); })} />
        </View>)}
        {state.hasMore && <Button title={t('Load more updates', 'عرض المزيد من التحديثات')} disabled={locked} onPress={() => void run(() => store.refresh(owner, true), 'refresh')} />}
      </>}
      <Button title={t('Refresh updates', 'تحديث الإشعارات')} secondary disabled={locked || !state.enabled} onPress={() => void run(() => store.refresh(owner), 'refresh')} />
    </>}
  </View>;
}
