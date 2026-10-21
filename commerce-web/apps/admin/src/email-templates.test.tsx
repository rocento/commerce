import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import type { EmailTemplate } from '@commerce/api-client';
import { EmailTemplateEditor } from './email-templates';

vi.mock('./unsaved-changes', () => ({ useUnsavedChanges: vi.fn() }));
const template: EmailTemplate = {
  key: 'order', name: 'Order confirmation', description: 'Confirm order details.', category: 'orders', revision: 3,
  draft: { subject: 'Your order', heading: 'Thank you', body: '{{message}}', cta_label: null },
  published: null, published_version: null, has_unpublished_changes: true, updated_at: null, updated_by: null,
  variables: [{ name: 'message', description: 'Order details', required: true, sample: 'Order #1001 confirmed.' }],
};
function render(canWrite: boolean, canPublish: boolean, initial = template) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><EmailTemplateEditor initial={initial} canWrite={canWrite} canPublish={canPublish} onBusyChange={() => {}} onDirtyChange={() => {}}/></QueryClientProvider>);
  client.clear();
  return html;
}
it('offers read-only previews and history without mutation controls', () => {
  const html = render(false, false);
  expect(html).toContain('View-only access');
  expect(html).toContain('Version history');
  expect(html).toContain('Plain text');
  expect(html).toContain('<fieldset disabled=""');
  expect(html).not.toContain('>Save draft<');
  expect(html).not.toContain('>Review &amp; publish<');
  expect(html).toContain('Publisher approval required');
});
it('separates author and publisher capabilities', () => {
  const author = render(true, false);
  expect(author).toContain('>Save draft<');
  expect(author).not.toContain('>Review &amp; publish<');
  const publisher = render(false, true);
  expect(publisher).not.toContain('>Save draft<');
  expect(publisher).toContain('>Review &amp; publish<');
  expect(publisher).toContain('Editing requires draft editor access');
});
it('shows built-in defaults as live and keeps order templates free of account buttons', () => {
  const html = render(true, true);
  expect(html).toContain('System default is live');
  expect(html).toContain('Required');
  expect(html).not.toContain('Button label');
  expect(html).toContain('Preview only. No email is sent.');
});
it('does not allow republishing unchanged content', () => {
  const html = render(true, true, { ...template, has_unpublished_changes: false, published_version: 2, published: template.draft });
  expect(html).toContain('Version 2 is live');
  expect(html).toMatch(/<button type="button" disabled="">Review &amp; publish<\/button>/);
});
it('always lets publishers reload a draft saved in another session', () => {
  const html = render(false, true, { ...template, has_unpublished_changes: false });
  expect(html.match(/>Reload latest version<\/button>/g)).toHaveLength(1);
  expect(html).toMatch(/<button type="button" class="secondary email-reload">Reload latest version<\/button>/);
});
it('places content, preview and history in separately labelled tab panels', () => {
  const html = render(true, true);
  expect(html).toContain('role="tablist" aria-label="Template workspace"');
  expect(html.match(/role="tab"/g)).toHaveLength(3);
  expect(html.match(/role="tabpanel"/g)).toHaveLength(3);
  expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*tabindex="0"[^>]*>Content<\/button>/);
  expect(html).toMatch(/role="tab"[^>]*aria-selected="false"[^>]*tabindex="-1"[^>]*>Preview<\/button>/);
  expect(html).toMatch(/role="tabpanel"[^>]*id="[^"]+-panel-preview"[^>]*aria-labelledby="[^"]+-tab-preview"[^>]*hidden=""/);
  expect(html).toMatch(/role="tabpanel"[^>]*id="[^"]+-panel-history"[^>]*aria-labelledby="[^"]+-tab-history"[^>]*hidden=""/);
  expect(html).not.toContain('email-compose-grid');
  expect(html).not.toContain('Content &amp; preview');
});
