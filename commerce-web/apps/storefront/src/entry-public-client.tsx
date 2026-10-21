import { configureDiscoveryAttribution, trackDiscovery } from './discovery-attribution';
import { hydrateRoot } from 'react-dom/client';
import { PublicPage } from './public/page';
import type { PublicSnapshot } from './public/types';
async function startPublicPage() {
const state = document.getElementById('publication-state');
const root = document.getElementById('root');
if (state && root) {
  const snapshot: PublicSnapshot = JSON.parse(state.textContent || 'null');
  if (snapshot?.schema_version === 1) {
    configureDiscoveryAttribution(snapshot.discovery_attribution_enabled === true);
    hydrateRoot(root, <PublicPage snapshot={snapshot} />);
    const sections = [...snapshot.theme.global.top, ...snapshot.theme.global.bottom, ...Object.values(snapshot.theme.pages).flat()];
    if (sections.some(section => section.enabled && section.component === 'best_sellers' && section.id in snapshot.collections)) {
      void import('./public/bestseller-location').then(module => module.restoreBestsellerLocation()).catch(() => { /* Keep the published global ranking when enhancement is unavailable. */ });
    }
    if (snapshot.status === 200) trackDiscovery(snapshot.path);
  }
}

}
void startPublicPage();
