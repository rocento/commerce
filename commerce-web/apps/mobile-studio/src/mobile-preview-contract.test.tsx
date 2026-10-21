import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MobileConfig } from '@commerce/api-client';
import { MobilePreview, previewTargets } from './mobile-preview';

const fixture = JSON.parse(readFileSync(new URL('../../../../commerce-api/rocento-api/crates/domain-mobile/contract/v1/fixtures/merchant-1.json', import.meta.url), 'utf8')) as MobileConfig;
function render(config: MobileConfig, locale: 'en' | 'ar') {
  return renderToStaticMarkup(<MobilePreview config={config} assets={[]} locale={locale} width={390} select={() => {}} />);
}
describe('Admin configuration reflected in both device previews', () => {
  it('reflects the single palette, icons and text components', () => {
    const config = structuredClone(fixture);
    config.brand.radiusToken = 'large';
    config.brand.density = 'compact';
    config.brand.light.primary = '#123456';
    config.navigation.icons = { home: 'location' };
    config.screens.home.sections = [{ id: 'copy', type: 'richText', props: { textKey: 'test_copy' } }];
    config.localization.messages.en!.test_copy = 'Managed component';
    config.localization.messages.ar!.test_copy = 'مكون مخصص';
    for (const locale of ['en', 'ar'] as const) {
      const html = render(config, locale);
      expect(html).toContain('--phone-primary:#123456');
      expect(html).toContain('--phone-radius:28px');
      expect(html).toContain('--phone-space:12px');
      expect(html).toContain('data-platform="iOS" data-icon="location"');
      expect(html).toContain('data-platform="Android" data-icon="location"');
      expect(html).not.toContain('data-icon="home"');
      expect(html.split(locale === 'ar' ? 'مكون مخصص' : 'Managed component')).toHaveLength(3);
    }
  });
  it('does not invent home components or wishlist controls absent from native runtime', () => {
    const html = render(fixture, 'en');
    expect(html).not.toContain('ms-home-search');
    expect(html).not.toContain('ms-home-shortcuts');
    expect(html).not.toContain('What will you discover today?');
    expect(html).not.toContain('aria-label="Open wishlist"');
    // Both native storefronts now expose delivery and search in their header.
    expect(html.match(/aria-label="Choose delivery location"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Header search"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Shopping assistant"/g)).toHaveLength(2);
  });
  it('keeps published-version previews read-only', () => {
    const html = renderToStaticMarkup(<MobilePreview config={fixture} assets={[]} locale="en" width={390} select={() => {}} readOnly />);
    expect(html).toContain('type="checkbox" disabled=""');
    expect(html).not.toContain('class="ms-preview-edit"');
  });
  it('labels every target as a simulation without inventing native acknowledgement', () => {
    for (const target of Object.keys(previewTargets) as (keyof typeof previewTargets)[]) {
      const html = renderToStaticMarkup(<MobilePreview config={fixture} assets={[]} locale="en" width={390} select={() => {}} target={target} savedRevision={7} hasLocalChanges />);
      expect(html).toMatch(/browser simulation/i);
      expect(html).toContain('Local changes · based on draft r7');
      expect(html).toContain('Native preview is not connected.');
      expect(html).not.toContain('Native applied draft');
      expect(html).toContain(`data-preview-target="${target}"`);
    }
  });
  it('preserves default icons for existing releases', () => {
    const html = render(fixture, 'en');
    expect(html).toContain('data-platform="iOS" data-icon="home"');
    expect(html).toContain('data-platform="Android" data-icon="home"');
  });
});
