import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { EffectiveIndexingPolicy } from '@commerce/api-client';
import { EffectiveIndexingStatus } from './effective-indexing-status';

describe('effective indexing display', () => {
  it.each([['INDEXABLE','Allowed'],['MERCHANT_DISABLED','Disabled'],['BLOCKED_BY_ENVIRONMENT','Protected environment'],['BLOCKED_BY_HEADER','Blocked'],['DOMAIN_UNVERIFIED','Domain unverified'],['CONFIGURATION_ERROR','Setup required']] as const)('shows the API state %s without deriving it from the enabled preference', (state, label) => {
    const policy: EffectiveIndexingPolicy = {
      state, installation_id: null, settings_revision: 9, merchant_preference: true,
      environment: 'production', canonical_origin: 'https://shop.example.test/',
      response_header: state === 'INDEXABLE' ? 'index, follow' : 'noindex, nofollow',
      robots_meta: state === 'INDEXABLE' ? 'index, follow' : 'noindex, nofollow',
      robots_txt: 'User-agent: *\nAllow: /\n', deployment_override: state === 'BLOCKED_BY_HEADER',
      external_headers: 'NOT_OBSERVED', warnings: ['Operator action required'],
    };
    const html = renderToStaticMarkup(<EffectiveIndexingStatus policy={policy}/>);
    expect(html).toContain(`<dt>Current indexing status</dt><dd>${label}</dd>`);
    expect(html).toContain('<dt>Saved revision</dt><dd>9</dd>');
    expect(html).toContain(policy.response_header);
    expect(html).toContain('Not observed');
    expect(html).toContain('Operator action required');
  });
});
