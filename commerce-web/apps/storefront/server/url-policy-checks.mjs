import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicTarget, canonicalTarget, validDestination } from './url-policy.mjs';
test('case, encoded ASCII, slash and tracking normalize before final resource redirect',()=>{
  assert.deepEqual(publicTarget('/PrOdUcTs/%61pples/?utm_source=mail'),{path:'/products/apples',page:1,locale:null});
  assert.deepEqual(publicTarget('/categories/fruit/?page=002&gclid=test'),{path:'/categories/fruit',page:2,locale:null});
  assert.equal(canonicalTarget('/categories/fruit',2),'/categories/fruit?page=2');
});
test('ambiguous and unsupported paths/parameters fail closed',()=>{
  for(const path of ['//attacker.example/products/a','/products/%2fa','/products/%5ca','/products/%252fa','/products/../a','/products/%2e%2e/a','/products/%ff','/products/a?sort=price','/products/a?variant=b','/categories/a?filter=color','/?page=1&page=2','/?page=0','/?page=10001','/products/a?page=2','/?utm_source=a&utm_source=b','/?lang=en&locale=en','/ar/products/a']) assert.equal(publicTarget(path),null,path);
});
test('only bounded normalized relative destinations are allowed',()=>{
  for(const path of ['/products/apples','/categories/fruit?page=2','/'])assert.equal(validDestination(path),true);
  for(const path of ['https://other.example/','//other.example/','/products/Apples','/products/a/','/categories/a?page=01','/categories/a?utm_source=x','/categories/a?page=2&sort=x'])assert.equal(validDestination(path),false,path);
});
