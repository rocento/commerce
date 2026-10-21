import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StaticRouter } from 'react-router-dom/server';
import { assistantProductLimit } from './assistant-product-layout';
import { AssistantRichResponse } from './assistant-rich';
vi.mock('./locations', () => ({ useDeliveryKey: () => 'default', useDeliveryStatus: () => ({ data: undefined }) }));
vi.mock('./assistant-product-layout', async importOriginal => ({
  ...await importOriginal<typeof import('./assistant-product-layout')>(),
  useAssistantProductLimit: () => assistantProductLimit(viewport),
}));
let viewport = 1440;
const products = Array.from({length: 8}, (_, i) => ({id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`, name: `Product ${i + 1}`, image_id: null, in_stock: true, price: '5', currency: 'USD', route: `/products/${i + 1}`, attributes: [], reasons: [], unmet: []}));
for (const [width, count] of [[390,4], [767,4], [768,6], [1023,6], [1024,8], [1440,8]]) {
  it(`renders ${count} recommendation cards at width ${width}`, () => {
    viewport = width;
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><StaticRouter location="/assistant"><AssistantRichResponse blocks={[{kind:'recommendation_group',products}]} busy={false} onCompare={() => {}} /></StaticRouter></QueryClientProvider>);
    expect(html.match(/class="assistant-rich-card"/g)).toHaveLength(count);
  });
}
