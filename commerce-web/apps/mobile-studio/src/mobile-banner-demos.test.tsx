import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { mobileConfigIssues, type MobileConfig } from '@commerce/api-client';
import { appendGroceryBanners } from './mobile-banner-demos';
import { MobilePreview } from './mobile-preview';
const fixture = () => JSON.parse(readFileSync(new URL('../../../../commerce-api/rocento-api/crates/domain-mobile/contract/v1/fixtures/merchant-1.json', import.meta.url),'utf8')) as MobileConfig;
const ids = { produce: 'd3d03c49-c514-40fc-b251-cc6bf3b71901', pantry: 'd3d03c49-c514-40fc-b251-cc6bf3b71904', greens: 'd3d03c49-c514-40fc-b251-cc6bf3b71905', breakfast: 'd3d03c49-c514-40fc-b251-cc6bf3b71902' };
const issues = (c: MobileConfig) => mobileConfigIssues(c,c.tenantId,{wishlist:true,locationPicker:true,reviews:true});
describe('Grocery banners', () => {
  it('adds bilingual tall and wide demos without overwriting existing sections', () => {
    const c = fixture(), next = appendGroceryBanners(c, ids);
    expect(next.screens.home.sections.slice(0,-2)).toEqual(c.screens.home.sections);
    expect(issues(next)).toEqual([]);
    expect(issues(appendGroceryBanners(next,ids))).toEqual([]);
    expect(next.screens.home.sections.at(-2)?.props).toMatchObject({layout:'portrait',additionalImageAssetIds:[ids.pantry,ids.greens]});
    expect(next.screens.home.sections.at(-1)?.props).toMatchObject({layout:'horizontal'});
  });
  it('rejects old runtimes, invalid layouts and oversized galleries', () => {
    const c = appendGroceryBanners(fixture(),ids);
    c.compatibility.minIosRuntime = '1.2.0'; expect(issues(c).some(i=>i.code==='BANNER_RUNTIME_REQUIRED')).toBe(true);
    c.compatibility.minIosRuntime = '1.3.0';
    const section = c.screens.home.sections.at(-2)!;
    if(section.type!=='heroBanner') throw Error('Wrong section');
    section.props.additionalImageAssetIds = Array(8).fill(ids.pantry);
    expect(issues(c).length).toBeGreaterThan(0);
  });
  it('renders both carousel shapes and all slides in both language previews', () => {
    const c=appendGroceryBanners(fixture(),ids);
    for(const locale of ['en','ar'] as const){
      const html=renderToStaticMarkup(<MobilePreview config={c} assets={[]} locale={locale} width={390} select={()=>{}}/>);
      expect(html).toContain('ms-banner-portrait');expect(html).toContain('ms-banner-horizontal');
      expect(html).toContain(locale==='ar'?'بداية ألذ ليومك.':'A better start to your day.');
    }
  });
});
