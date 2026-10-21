import { describe, expect, it } from 'vitest';
import type { Location, Cart } from '@commerce/api-client';
import { reorderAddress, reorderCartSignature, sameReorderAddress } from './reorder-logic';
const home = {id:'home',formatted_address:'Garden St',latitude:30,longitude:31,building:'2',floor:'1',apartment:'4',delivery_instructions:'Bell',is_default:true,location_method:'pin'} as Location;
describe('reorder address decisions', () => {
 it('reuses the original address when the default is unchanged', () => expect(reorderAddress(home,[home])).toBe(home));
 it('requires confirmation when the default differs', () => expect(reorderAddress(home,[{...home,is_default:false},{...home,id:'work',building:'3'}])).toBeUndefined());
 it('does not trust a matching ID after edits', () => expect(reorderAddress(home,[{...home,apartment:'5'}])).toBeUndefined());
 it('requires confirmation for deleted and pickup addresses', () => { expect(reorderAddress(home,[])).toBeUndefined(); expect(reorderAddress({...home,location_method:'pickup'},[home])).toBeUndefined(); });
 it('compares delivery instructions as well as coordinates', () => expect(sameReorderAddress(home,{...home,delivery_instructions:'Gate'})).toBe(false));
});
it('cart comparisons detect quantity and price changes but ignore line ordering', () => {
 const a = {items:[{product_id:'a',quantity:1,price:'2'},{product_id:'b',quantity:2,price:'3'}]} as Cart;
 expect(reorderCartSignature(a)).toBe(reorderCartSignature({...a,items:[...a.items].reverse()}));
 expect(reorderCartSignature(a)).not.toBe(reorderCartSignature({...a,items:[{...a.items[0],quantity:2},a.items[1]]}));
});
