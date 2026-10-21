import { expect, it } from 'vitest';
import type { Cart } from '@commerce/api-client';
import { cartPage, completeCartSnapshot } from './assistant-cart-pagination';
const cart = {items:Array.from({length:23},(_,i)=>({product_id:String(i),name:`Product ${i}`,price:'2.00',currency:'USD',quantity:2,line_total:'4.00'})),subtotal:'92.00',discount_amount:'1.00',currency:'USD',fully_reserved:true} as Cart;
it('visits every product exactly once, with full totals preserved on every page', () => {
 const snapshot = completeCartSnapshot(cart);
 const pages = [0,1,2].map(page => cartPage(snapshot,page));
 expect(pages.map(p=>p.items.length)).toEqual([10,10,3]);
 expect(pages.flatMap(p=>p.items.map(i=>i.product_id))).toEqual(cart.items.map(i=>i.product_id));
 expect(snapshot.total_quantity).toBe(46);
 expect(snapshot.subtotal).toBe('92.00');
 expect(snapshot.discount_amount).toBe('1.00');
});
it('handles an emptied or smaller refreshed cart and clamps page boundaries', () => {
 const empty = completeCartSnapshot({...cart,items:[],subtotal:'0.00'});
 expect(cartPage(empty,5)).toMatchObject({page:0,pages:1,items:[]});
 expect(empty.total_quantity).toBe(0);
 expect(cartPage(completeCartSnapshot(cart),99).page).toBe(2);
 expect(cartPage(completeCartSnapshot(cart),-1).page).toBe(0);
});
