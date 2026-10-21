import { describe, expect, it } from 'vitest';
import type { Category } from '@commerce/api-client';
import { categoryDescendants, categoryTrail, categoryTree, filterCategoryTree } from './category-tree';
const category=(id:string,name:string,parent_id:string|null=null):Category=>({id,name,parent_id,slug:name.toLowerCase().replaceAll(' ','-'),thumbnail:null,banner:null});
const categories=[category('root','Clothing'),category('women','Women','root'),category('dresses','Dresses','women'),category('men','Men','root'),category('shoes','Shoes')];
describe('category hierarchy',()=>{
  it('builds sorted complete trees independently of row order',()=>{
    const tree=categoryTree([...categories].reverse());
    expect(tree.map(node=>node.category.id)).toEqual(['root','shoes']);
    expect(tree[0].children.map(node=>node.category.id)).toEqual(['men','women']);
    expect(tree[0].children[1].children[0].category.id).toBe('dresses');
  });
  it('search keeps matching descendants and their ancestor path',()=>{
    const tree=filterCategoryTree(categoryTree(categories),'dresses');
    expect(tree[0].category.id).toBe('root');expect(tree[0].children).toHaveLength(1);expect(tree[0].children[0].children[0].category.id).toBe('dresses');
    expect(filterCategoryTree(categoryTree(categories),'not found')).toEqual([]);
  });
  it('excludes self and all descendants from valid move destinations',()=>{
    expect([...categoryDescendants(categories,'women')].sort()).toEqual(['dresses','women']);
    expect(categoryDescendants(categories,'root').has('shoes')).toBe(false);
  });
  it('retains orphaned categories and breaks corrupt cycles without dropping nodes',()=>{
    const broken=[category('a','A','b'),category('b','B','a'),category('c','C','missing')];
    const tree=categoryTree(broken);expect(tree.map(node=>node.category.id)).toEqual(['a','c']);expect(tree[0].children[0].category.id).toBe('b');
    expect(categoryDescendants(broken,'a').size).toBe(2);expect(categoryTrail(broken,'a')).toHaveLength(2);
  });
  it('computes complete breadcrumb paths',()=>expect(categoryTrail(categories,'dresses').map(item=>item.name)).toEqual(['Clothing','Women','Dresses']));
});
