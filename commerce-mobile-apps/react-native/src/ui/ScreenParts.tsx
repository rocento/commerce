import { useContext, type ReactNode } from 'react';
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { Copy, UiContext } from './Storefront';

export function ScreenSheet({ visible, title, close, children, footer, scroll = true, fullScreen = false, bottomSheet = false, headerRight }: { visible: boolean; title: string; close: () => void; children: ReactNode; footer?: ReactNode; scroll?: boolean; fullScreen?: boolean; bottomSheet?: boolean; headerRight?: ReactNode }) {
  const { colors, rtl } = useContext(UiContext);
  return <Modal key={fullScreen ? 'full' : 'sheet'} visible={visible} animationType="slide" transparent={bottomSheet} presentationStyle={bottomSheet ? 'overFullScreen' : fullScreen ? 'fullScreen' : 'pageSheet'} onRequestClose={close}>
    <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: bottomSheet ? 'rgba(0,0,0,0.35)' : colors.background }}>
    {bottomSheet && <Pressable accessibilityRole="button" accessibilityLabel={rtl ? 'إغلاق' : 'Close'} onPress={close} style={StyleSheet.absoluteFill} />}
    <View style={bottomSheet ? { height: '85%', flexShrink: 0, borderTopLeftRadius: 20, borderTopRightRadius: 20, overflow: 'hidden' } : { flex: 1 }}><SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: colors.background }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={[styles.bar, { flexDirection: rtl ? 'row-reverse' : 'row', borderColor: colors.border }]}>
          <Pressable accessibilityRole="button" accessibilityLabel={rtl ? 'تم' : 'Done'} onPress={close} style={styles.close}><Copy style={{ color: colors.primary }}>{fullScreen ? (rtl ? 'رجوع ›' : '‹ Back') : (rtl ? 'تم' : 'Done')}</Copy></Pressable>
          <Copy accessibilityRole="header" style={{ flex: 1, fontSize: 17, fontWeight: '600', textAlign: 'center' }}>{title}</Copy>
          <View style={{ minWidth: 44 }}>{headerRight}</View>
        </View>
        {scroll ? <ScrollView key={title} keyboardShouldPersistTaps="handled" keyboardDismissMode="interactive" contentContainerStyle={styles.content}>{children}</ScrollView> : <View style={{ flex: 1 }}>{children}</View>}
        {footer && <View style={[styles.footer, { borderColor: colors.border }]}>{footer}</View>}
      </KeyboardAvoidingView>
    </SafeAreaView></SafeAreaProvider></View></View>
  </Modal>;
}

export function MenuRow({ title, detail, onPress, disabled = false }: { title: string; detail?: string; onPress: () => void; disabled?: boolean }) {
  const { colors, rtl } = useContext(UiContext);
  return <Pressable accessibilityRole="button" accessibilityLabel={title} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.menu, { flexDirection: rtl ? 'row-reverse' : 'row', opacity: disabled ? 0.45 : pressed ? 0.65 : 1 }]}>
    <View style={{ flex: 1, gap: 3 }}><Copy style={{ fontWeight: '500' }}>{title}</Copy>{detail && <Copy style={{ fontSize: 13, color: colors.muted }}>{detail}</Copy>}</View>
    <Copy style={{ color: colors.muted, fontSize: 24, writingDirection: 'ltr', textAlign: 'center' }}>{rtl ? '‹' : '›'}</Copy>
  </Pressable>;
}

export function AmountRow({ label, value, total = false }: { label: string; value: string; total?: boolean }) {
  const { rtl, colors } = useContext(UiContext);
  return <View style={{ flexDirection: rtl ? 'row-reverse' : 'row', justifyContent: 'space-between', gap: 12, paddingVertical: total ? 14 : 4, borderTopWidth: total ? StyleSheet.hairlineWidth : 0, borderColor: colors.border }}>
    <Copy style={{ flex: 1, fontWeight: total ? '700' : '400' }}>{label}</Copy><Copy style={{ fontWeight: total ? '700' : '500' }}>{value}</Copy>
  </View>;
}

const styles = StyleSheet.create({
  bar: { paddingHorizontal: 20, minHeight: 56, alignItems: 'center', gap: 12, borderBottomWidth: StyleSheet.hairlineWidth },
  close: { minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 20, gap: 18, paddingBottom: 32, maxWidth: 720, width: '100%', alignSelf: 'center' },
  footer: { padding: 20, borderTopWidth: StyleSheet.hairlineWidth, gap: 10 },
  menu: { padding: 16, minHeight: 60, alignItems: 'center', gap: 12 },
});
