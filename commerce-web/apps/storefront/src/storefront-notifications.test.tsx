import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { customerApi, defaultTheme } from '@commerce/api-client';
import { PublicPage } from './public/page';
import type { PublicSnapshot } from './public/types';

it('renders a neutral bell in published HTML without restoring or exposing customer state', () => {
  const restore = vi.spyOn(customerApi, 'restore');
  const snapshot = { theme: defaultTheme(), locale: 'en', categories: [], category_id: null, product: null, kind: 'home', images: {}, collections: {}, products: [], page: 1, has_next: false, path: '/', status: 200, site_name: 'Store', content: null, guides: [], merchant: null } as unknown as PublicSnapshot;
  const html = renderToStaticMarkup(<PublicPage snapshot={snapshot}/>);
  expect(html).toMatch(/aria-label="Notifications"[^>]*disabled=""/);
  expect(html).not.toContain('sn-badge');
  expect(html).not.toContain('Personal updates');
  expect(restore).not.toHaveBeenCalled();
  const arabic = renderToStaticMarkup(<PublicPage snapshot={{ ...snapshot, locale: 'ar' }}/>);
  expect(arabic).toContain('aria-label="الإشعارات"');
  restore.mockRestore();
});
