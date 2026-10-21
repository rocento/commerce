import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { expect, it, vi } from 'vitest';
import { themeContract } from '@commerce/api-client';
const settings = vi.hoisted(() => ({ cart_display: 'sidebar_and_page' }));
vi.mock('./themes', () => ({ useTheme: () => ({}), themeOptions: () => settings }));
vi.mock('./locations', () => ({ useDeliveryKey: () => 'none', useDeliveryStatus: () => ({}) }));
import { CartLink } from './cart';
const render = (path = '/') => renderToStaticMarkup(<StaticRouter location={path}><CartLink /></StaticRouter>);
it('defaults the theme contract to a sidebar while keeping a real cart link', () => {
  expect(themeContract.components.header_options.settings.cart_display.default).toBe('sidebar_and_page');
  settings.cart_display = 'sidebar_and_page';
  expect(render()).toContain('aria-haspopup="dialog"');
  expect(render()).toContain('href="/cart"');
});
it('uses the page when configured and avoids reopening the drawer on the cart page', () => {
  settings.cart_display = 'page_only';
  expect(render()).not.toContain('aria-haspopup');
  settings.cart_display = 'sidebar_and_page';
  expect(render('/cart')).not.toContain('aria-haspopup');
  expect(render('/assistant')).not.toContain('aria-haspopup');
});
