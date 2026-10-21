import { StyleSheet } from 'react-native';
import { storefrontColors } from '../core/designColors';

export const storefrontStyles = (colors: ReturnType<typeof storefrontColors>) => StyleSheet.create({
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700', letterSpacing: -0.5 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 22 }, centerCopy: { textAlign: 'center' },
  emptyState: { gap: 18, paddingVertical: 20 }, symbol: { width: 64, height: 64, borderRadius: 32, backgroundColor: colors.tint, alignItems: 'center', justifyContent: 'center', alignSelf: 'center' },
  benefits: { gap: 16, paddingVertical: 12 }, benefit: { flex: 1, alignItems: 'center', gap: 8 },
  panel: { borderRadius: 16, borderWidth: 1, borderColor: colors.border, overflow: 'hidden' }, panelCard: { borderRadius: 16, borderWidth: 1, borderColor: colors.border, padding: 16, gap: 14 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border }, eyebrow: { fontSize: 12, fontWeight: '600', letterSpacing: 1.6, color: colors.muted },
  cartRow: { backgroundColor: colors.surface, paddingVertical: 16, gap: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  stepper: { borderWidth: 1, borderColor: colors.border, borderRadius: 22 }, step: { minWidth: 44, minHeight: 44, justifyContent: 'center' },
  checkoutDock: { paddingHorizontal: 20, paddingVertical: 12, gap: 10, backgroundColor: colors.surface, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  timeline: { borderStartWidth: 2, borderColor: colors.border, paddingStart: 16, gap: 8, paddingVertical: 8 },
  safe: { flex: 1 }, shell: { flex: 1, width: '100%', maxWidth: 960, alignSelf: 'center' }, grow: { flex: 1 },
  header: { paddingHorizontal: 16, paddingVertical: 8, gap: 10 }, logo: { width: 72, height: 36 }, location: { fontSize: 15, fontWeight: '600' }, language: { minHeight: 44, justifyContent: 'center' }, search: { minHeight: 48, borderRadius: 14, paddingHorizontal: 12, gap: 10, alignItems: 'center' }, searchInput: { flex: 1, minWidth: 0, minHeight: 48, fontSize: 16 },
  content: { padding: 20, gap: 18, paddingBottom: 36 }, caption: { fontSize: 12, lineHeight: 20 },
  hero: { borderRadius: 8, overflow: 'hidden' }, heroImage: { width: '100%', aspectRatio: 1 }, heroCopy: { paddingHorizontal: 12, paddingVertical: 24, gap: 12 }, heroTitle: { fontSize: 27, lineHeight: 34, letterSpacing: -0.5, fontWeight: '500' }, heroBody: { fontSize: 16, lineHeight: 24 }, shopLink: { minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' },
  heading: { fontSize: 24, lineHeight: 34, fontWeight: '700' }, productTitle: { fontSize: 17, lineHeight: 25, fontWeight: '600' }, price: { fontSize: 18, fontWeight: '700', marginVertical: 10 },
  grid: { flexWrap: 'wrap', gap: 20 }, card: { gap: 12 },
  art: { height: 150, borderRadius: 8, marginBottom: 12, overflow: 'hidden', justifyContent: 'center', alignItems: 'center' }, largeArt: { height: 260 }, image: { width: '100%', height: '100%' }, placeholder: { fontSize: 60, lineHeight: 80 },
  field: { gap: 7 }, label: { fontSize: 14, lineHeight: 22, fontWeight: '600' }, input: { minHeight: 50, borderWidth: 1, borderRadius: 8, padding: 12, fontSize: 17 },
  block: { padding: 16, borderRadius: 8, gap: 14 }, banner: { padding: 12 }, loading: { padding: 12 },
  tabs: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 8, paddingVertical: 4 }, tab: { flex: 1, minHeight: 60, paddingVertical: 4, gap: 4, alignItems: 'center', justifyContent: 'center', borderRadius: 24 }, tabLabel: { textAlign: 'center', fontSize: 13, lineHeight: 18 },
});
