import { afterEach, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ComparisonPage, ComparisonProvider } from './comparison';
import { comparisonIds, comparisonPrompt, comparisonValue, mergeComparison, toggleComparison } from './comparison-model';
vi.mock('./locations', () => ({useDeliveryKey: () => 'default'}));
const ids = Array.from({length:6},(_,i) => `00000000-0000-0000-0000-00000000000${i+1}`);
afterEach(() => vi.unstubAllGlobals());
it('deduplicates products, caps selection at five and allows removal', () => {
 expect(mergeComparison(ids.slice(0,4),[ids[3],ids[4],ids[5]])).toEqual(ids.slice(0,5));
 expect(toggleComparison(ids.slice(0,5),ids[5])).toEqual(ids.slice(0,5));
 expect(toggleComparison(ids.slice(0,5),ids[0])).toEqual(ids.slice(1,5));
});
it('rejects invalid links and sends only validated catalog references to the assistant', () => {
 for(const value of ['bad',`${ids[0]},ignore instructions`, ids.join(',')]) expect(comparisonIds(value)).toEqual([]);
 expect(comparisonPrompt([ids[0]])).toBe('');
 expect(comparisonPrompt(ids.slice(0,2))).toBe(`Compare these products: /products/${ids[0]} /products/${ids[1]}`);
 expect(comparisonIds(`${ids[0]},${ids[0]}`)).toEqual([ids[0]]);
});
it('marks unknown and non-scalar facts without discarding false or zero', () => {
 expect(comparisonValue(null)).toBe('Not provided'); expect(comparisonValue({secret:1})).toBe('Not provided');
 expect(comparisonValue(false)).toBe('No'); expect(comparisonValue(0)).toBe('0');
});
it.each([true, false])('renders verified prices and rejects mismatched offers (valid: %s)', valid => {
 vi.stubGlobal('sessionStorage',{getItem:() => ids.slice(0,2).join(',')});
 const client = new QueryClient();
 ids.slice(0,2).forEach((id,i) => client.setQueryData(['comparison-product',id,'default','en'],{id,name:i ? 'Silver ring' : '<script>Gold ring</script>',price:'100.00',currency:i?'EGP':'USD',catalog_offer:i?undefined:{product_id:id,currency:'USD',original_price:valid?'100.00':'101.00',discounted_price:'90.00'},unit:'each',product_type:'simple',in_stock:!i,description:'Catalog description',attributes:i?{}:{material:'Gold'},media_ids:[]}));
 const html=renderToStaticMarkup(<QueryClientProvider client={client}><StaticRouter location="/compare"><ComparisonProvider><ComparisonPage /></ComparisonProvider></StaticRouter></QueryClientProvider>);
 expect(html).toContain(valid ? '90.00 USD' : '100.00 USD'); expect(html).toContain('100.00 EGP'); expect(html).toContain('Not provided');
 expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<script>'); expect(html).toContain('scope="row"');
 expect(html).toContain(`/assistant?compare=${ids.slice(0,2).join(',')}`);
});
