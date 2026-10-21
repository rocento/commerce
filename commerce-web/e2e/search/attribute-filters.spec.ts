import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const contract = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8'));
const attribute = (code: string, type: string, options: {value:string;label:string}[], order: number) => ({
  id:code,entity_id:order+1,entity_type:'product',attribute_code:code,label:code === 'color' ? 'Color' : 'Organic',
  input_type:type,scope:'global',is_filterable:true,is_visible_on_front:true,is_required:false,is_unique:false,
  is_searchable:true,is_comparable:false,used_for_configurations:false,used_for_promo_rules:false,swatch_type:'none',
  options,version:1,metadata:{status:'active',facetable:true,display_order:order},
});

for (const [width, layout] of [[1440,'vertical'],[1440,'horizontal'],[390,'vertical']] as const) {
  test(`attribute checkboxes, counts and history work at ${width}px with ${layout} filters`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({width,height:1000});
    await page.addInitScript(() => sessionStorage.setItem('commerce-guest-location', JSON.stringify({latitude:30,longitude:31,formatted_address:'Test address',label:'home',building:'1'})));
    const theme = structuredClone(contract.default);
    for (const section of [...theme.global.top,...theme.pages.search]) if (section.component === 'catalog_filters') section.settings.layout = layout;
    const requests: URL[] = [];
    await page.route('**/api/**', async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (path.includes('/theme/')) return route.fulfill({json:{configuration:theme,cities:[]}});
      if (path.endsWith('/auth/refresh')) return route.fulfill({status:401,json:{error:'Unauthorized'}});
      if (path.endsWith('/languages')) return route.fulfill({json:{source_locale:'en',languages:[]}});
      if (path.endsWith('/cart')) return route.fulfill({json:{items:[],subtotal:'0.00',currency:'USD'}});
      if (path.endsWith('/catalog/attribute-definitions')) return route.fulfill({json:[
        attribute('color','select',[{value:'red',label:'Red'},{value:'blue',label:'Blue'},{value:'green',label:'Green'}],0),
        attribute('organic','boolean',[],1),
      ]});
      if (path.endsWith('/search')) {
        requests.push(url);
        return route.fulfill({json:{hits:[],total:4,offset:0,limit:24,facets:{color:{red:2,blue:2},organic:{true:3,false:1}}}});
      }
      if (path.includes('/content/')) return route.fulfill({status:404,json:{error:'No published content'}});
      if (path.includes('/delivery-area')) return route.fulfill({json:{configured:false,deliverable:true}});
      return route.fulfill({json:[]});
    });
    await page.goto('/search?q=tea&min=5&sort_by=price&offset=24');
    if (width === 390) await page.getByRole('button',{name:'Show filters'}).click();
    const red = page.getByRole('checkbox',{name:'Color: Red',exact:true});
    const blue = page.getByRole('checkbox',{name:'Color: Blue',exact:true});
    if (layout === 'horizontal') {
      await expect(page.locator('details.attribute-checkbox-filter[open]')).toHaveCount(0);
      await page.locator('summary').filter({hasText:/^Color/}).click();
      await page.locator('summary').filter({hasText:/^Organic/}).click();
    }
    await expect(red).toBeVisible();
    await expect(red.locator('..')).toContainText('(2)');
    await expect(page.getByRole('checkbox',{name:'Color: Green',exact:true})).toHaveCount(0);
    await red.check();
    await expect.poll(() => JSON.parse(new URL(page.url()).searchParams.get('attributes') ?? '{}')).toEqual({color:['red']});
    await expect(blue).toBeVisible();
    await expect(red).toBeFocused();
    await blue.check();
    await expect.poll(() => JSON.parse(new URL(page.url()).searchParams.get('attributes') ?? '{}')).toEqual({color:['red','blue']});
    await page.getByRole('checkbox',{name:'Organic: No',exact:true}).check();
    await expect.poll(() => JSON.parse(new URL(page.url()).searchParams.get('attributes') ?? '{}')).toEqual({color:['red','blue'],organic:[false]});
    await expect.poll(() => requests.some(url => url.searchParams.get('attribute_filters') === JSON.stringify({color:['red','blue'],organic:[false]}))).toBe(true);
    const params = new URL(page.url()).searchParams;
    expect(params.get('q')).toBe('tea'); expect(params.get('min')).toBe('5'); expect(params.get('sort_by')).toBe('price'); expect(params.has('offset')).toBe(false);
    const colorGroup = page.locator('details').filter({has:page.locator('summary').filter({hasText:/^Color/})});
    await colorGroup.locator('summary').click();
    await expect(colorGroup).not.toHaveAttribute('open');
    await page.getByRole('button',{name:'Remove Color: Red',exact:true}).click();
    await expect.poll(() => JSON.parse(new URL(page.url()).searchParams.get('attributes') ?? '{}')).toEqual({color:['blue'],organic:[false]});
    await expect(colorGroup).not.toHaveAttribute('open');
    await colorGroup.locator('summary').click();
    await expect(red).not.toBeChecked(); await expect(blue).toBeChecked();
    await page.goBack();
    await expect(red).toBeChecked(); await expect(blue).toBeChecked();
    await page.reload();
    if (width === 390) await page.getByRole('button',{name:'Show filters'}).click();
    if (layout === 'horizontal') {
      await expect(page.locator('details.attribute-checkbox-filter[open]')).toHaveCount(0);
      await page.locator('summary').filter({hasText:/^Color/}).click();
      await page.locator('summary').filter({hasText:/^Organic/}).click();
    }
    await expect(red).toBeChecked(); await expect(page.getByRole('checkbox',{name:'Organic: No',exact:true})).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath('attribute-checkboxes.png'),fullPage:true});
    await page.getByRole('button',{name:'Reset all filters'}).click();
    await expect(page).not.toHaveURL(/attributes=|min=|offset=/);
    await expect(red).not.toBeChecked(); await expect(blue).not.toBeChecked();
    expect(errors).toEqual([]);
  });
}
