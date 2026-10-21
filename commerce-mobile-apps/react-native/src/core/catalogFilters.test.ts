import { expect, it } from 'vitest';
import { emptyFilters, filterParameters, validFilters } from './catalogFilters';
it('sends category price, stock and ordering filters using the commerce contract', () => {
  const params = filterParameters({minimum:'10.50',maximum:'100',inStock:true,sort:'price_desc'});
  expect(Object.fromEntries(params)).toEqual({ min_price:'10.50',max_price:'100',in_stock:'true',sort_by:'price',sort_order:'desc' });
  expect(filterParameters(emptyFilters).toString()).toBe('');
});
it('rejects inverted, negative and nonfinite ranges while allowing open ranges', () => {
  for (const [minimum,maximum] of [['20','10'],['-1',''],['NaN',''],['','Infinity']]) {
    expect(validFilters({...emptyFilters,minimum:minimum!,maximum:maximum!})).toBe(false);
  }
  expect(validFilters({...emptyFilters,minimum:'0',maximum:'0'})).toBe(true);
  expect(validFilters({...emptyFilters,minimum:'12'})).toBe(true);
});
