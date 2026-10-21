import { View, type ViewStyle } from 'react-native';

// Native outline shapes keep navigation consistent on iOS, Android and web
// without depending on platform-specific Unicode glyphs or a loaded icon font.
export function NavigationIcon({ name, color, size = 24 }: { size?: number; name: 'compare' | 'home' | 'catalog' | 'search' | 'bag' | 'account' | 'deals' | 'assistant' | 'heart' | 'cart' | 'location' | 'notifications'; color: string }) {
  const outline: ViewStyle = { position: 'absolute', borderColor: color, borderWidth: 1.8 };
  return <View accessible={false} importantForAccessibility="no-hide-descendants" style={{ width: size, height: size }}><View style={{ width: 24, height: 24, transform: [{ scale: size / 24 }], transformOrigin: 'top left' }}>
    {name === 'compare' && <>{[2, 14].map(left => <View key={left} style={[outline, { left, top: 3, width: 8, height: 18, borderRadius: 2 }]} />)}</>}
    {name === 'notifications' && <><View style={[outline, { width: 14, height: 15, left: 5, top: 3, borderTopLeftRadius: 8, borderTopRightRadius: 8, borderBottomLeftRadius: 2, borderBottomRightRadius: 2 }]} /><View style={{ position: 'absolute', width: 4, height: 3, left: 10, top: 20, borderRadius: 2, backgroundColor: color }} /></>}
    {name === 'home' && <>
      <View style={[outline, { width: 14, height: 14, top: 2, left: 5, transform: [{ rotate: '45deg' }], borderRightWidth: 0, borderBottomWidth: 0 }]} />
      <View style={[outline, { width: 16, height: 13, left: 4, top: 10, borderTopWidth: 0, borderRadius: 1 }]} />
      <View style={[outline, { width: 5, height: 8, bottom: 1, left: 9.5, borderBottomWidth: 0 }]} />
    </>}
    {name === 'catalog' && [0, 1, 2, 3].map(index => <View key={index} style={[outline, { width: 8, height: 8, left: 2 + (index % 2) * 12, top: 2 + Math.floor(index / 2) * 12, borderRadius: 2 }]} />)}
    {name === 'search' && <>
      <View style={[outline, { width: 16, height: 16, top: 1, left: 1, borderRadius: 8 }]} />
      <View style={{ position: 'absolute', width: 10, height: 2, backgroundColor: color, top: 18, left: 14, transform: [{ rotate: '45deg' }] }} />
    </>}
    {name === 'deals' && <><View style={[outline, { width: 17, height: 14, left: 4, top: 5, borderRadius: 3, transform: [{ rotate: '-40deg' }] }]} /><View style={[outline, { width: 4, height: 4, top: 11, left: 7, borderRadius: 2 }]} /></>}
    {name === 'assistant' && <><View style={[outline, { width: 21, height: 16, left: 1, top: 2, borderRadius: 6 }]} /><View style={[outline, { width: 6, height: 6, top: 15, left: 5, borderTopWidth: 0, borderRightWidth: 0, transform: [{ skewY: '-30deg' }] }]} /></>}
    {name === 'heart' && <><View style={[outline, { width: 13, height: 17, left: 4, top: 3, borderTopLeftRadius: 8, borderTopRightRadius: 8, borderBottomWidth: 0, transform: [{ rotate: '-45deg' }] }]} /><View style={[outline, { width: 13, height: 17, left: 9, top: 3, borderTopLeftRadius: 8, borderTopRightRadius: 8, borderBottomWidth: 0, transform: [{ rotate: '45deg' }] }]} /></>}
    {name === 'location' && <><View style={[outline, { width: 13, height: 17, left: 5, top: 1, borderRadius: 9 }]} /><View style={[outline, { width: 5, height: 5, left: 9, top: 5, borderRadius: 3 }]} /><View style={[outline, { width: 19, height: 6, left: 2, top: 17, borderRadius: 10 }]} /></>}
    {name === 'cart' && <><View style={[outline, { width: 17, height: 12, left: 5, top: 5, transform: [{ skewX: '-10deg' }] }]} /><View style={{ width: 7, height: 2, backgroundColor: color, position: 'absolute', left: 0, top: 2 }} />{[8,19].map(left => <View key={left} style={{ width: 4, height: 4, borderRadius: 2, backgroundColor: color, position: 'absolute', left, top: 20 }} />)}</>}
    {name === 'bag' && <>
      <View style={[outline, { width: 18, height: 16, left: 3, top: 7, borderRadius: 3 }]} />
      <View style={[outline, { width: 8, height: 9, left: 8, top: 1, borderRadius: 5, borderBottomWidth: 0 }]} />
    </>}
    {name === 'account' && <>
      <View style={[outline, { width: 9, height: 9, left: 7.5, top: 1, borderRadius: 5 }]} />
      <View style={[outline, { width: 20, height: 11, left: 2, top: 13, borderTopLeftRadius: 11, borderTopRightRadius: 11, borderBottomLeftRadius: 3, borderBottomRightRadius: 3 }]} />
    </>}
  </View></View>;
}
