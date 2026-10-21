import { SafeAreaProvider } from 'react-native-safe-area-context';
import { bundledConfiguration } from './src/core/storefront';
import { liveConfiguration } from './src/platform/commerce';
import { LiveStorefront } from './src/ui/LiveStorefront';
import { Storefront } from './src/ui/Storefront';

export default function App() {
  if (__DEV__ && process.env.EXPO_PUBLIC_VISUAL_QA === '1') {
    const VisualPreview = require('./src/testing/VisualPreview').default;
    return <SafeAreaProvider><VisualPreview /></SafeAreaProvider>;
  }
  if (__DEV__ && process.env.EXPO_PUBLIC_ACCEPTANCE === '1') {
    const Acceptance = require('./src/testing/Acceptance').default;
    return <SafeAreaProvider><Acceptance /></SafeAreaProvider>;
  }
  return <SafeAreaProvider>{process.env.EXPO_PUBLIC_DEMO === '1' ? <Storefront configuration={bundledConfiguration} /> : <LiveStorefront configuration={liveConfiguration} />}</SafeAreaProvider>;
}
