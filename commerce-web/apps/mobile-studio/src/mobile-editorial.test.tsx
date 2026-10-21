import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { mobileConfigIssues, type MobileConfig } from '@commerce/api-client';
import { MobilePreview } from './mobile-preview';
import { duplicateSection, updateEditorialText } from './mobile-section-library';
const fixture = () => JSON.parse(readFileSync(new URL('../../../../commerce-api/rocento-api/crates/domain-mobile/contract/v1/fixtures/merchant-1.json',import.meta.url),'utf8')) as MobileConfig;
function editorial() {
 const c=fixture();c.compatibility={minIosRuntime:'1.2.0',minAndroidRuntime:'1.2.0'};c.screens.home.layout='storefront';
 c.screens.home.sections=[{id:'story',type:'heroBanner',props:{imageAssetId:c.brand.logoAssetId,accessibilityLabelKey:'alt',headingKey:'heading',bodyKey:'body',eyebrowKey:'eyebrow',labelKey:'button',appearance:'editorial',action:{type:'openTab',tab:'categories'}}}];
 c.localization.messages={en:{alt:'Collection image',heading:'Your next upgrade.',body:'Made for every day.',eyebrow:'THE COLLECTION',button:'Explore phones'},ar:{alt:'صورة المجموعة',heading:'اكتشف الجديد',body:'لكل يوم',eyebrow:'المجموعة',button:'اكتشف الهواتف'}};
 return c;
}
const issues=(c:MobileConfig)=>mobileConfigIssues(c,c.tenantId,{wishlist:true,locationPicker:true,reviews:true});
describe('Storefront home composition',()=>{
 it('requires the editorial runtime and complete localized copy',()=>{
  const c=editorial();expect(issues(c)).toEqual([]);
  c.compatibility.minIosRuntime='1.1.0';expect(issues(c).some(i=>i.code==='EDITORIAL_RUNTIME_REQUIRED')).toBe(true);
  c.compatibility.minIosRuntime='1.2.0';delete c.localization.messages.ar!.body;expect(issues(c).some(i=>i.code==='MISSING_TRANSLATION')).toBe(true);
 });
 it('renders authored copy instead of generic campaign text in both previews',()=>{
  const html=renderToStaticMarkup(<MobilePreview config={editorial()} assets={[]} locale="en" width={390} select={()=>{}}/>);
  expect(html.split('Your next upgrade.')).toHaveLength(3);expect(html).toContain('Made for every day.');expect(html).toContain('Explore phones');
  expect(html).not.toContain('A little fresher.');expect(html).not.toContain('Good things,');expect(html).not.toContain('YOUR EVERYDAY, BEAUTIFULLY CHOSEN');
 });
 it('duplicates all editorial text independently and edits one translation safely',()=>{
  const c=editorial(),next=duplicateSection(c,'story'),duplicate=next.screens.home.sections[1];
  expect(issues(next)).toEqual([]);
  if(duplicate.type!=='heroBanner')throw Error('wrong type');
  expect(duplicate.props.bodyKey).not.toBe('body');expect(duplicate.props.labelKey).not.toBe('button');
  const edited=updateEditorialText(next,duplicate.id,'bodyKey','en','New copy');
  expect(edited.localization.messages.en!.body).toBe('Made for every day.');expect(issues(edited)).toEqual([]);
 });
 it('rejects arbitrary button URLs and unbounded product limits',()=>{
  const c=editorial(),section=c.screens.home.sections[0];if(section.type!=='heroBanner')throw Error('wrong type');
  section.props.storefrontPath='//evil.test';expect(issues(c).length).toBeGreaterThan(0);
  delete section.props.storefrontPath;c.screens.home.sections=[{id:'products',type:'productGrid',props:{collectionId:'demo-feed-featured',titleKey:'heading',columns:2,limit:25}}];expect(issues(c).length).toBeGreaterThan(0);
 });
});
