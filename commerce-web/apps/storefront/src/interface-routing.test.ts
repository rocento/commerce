import { expect, it } from 'vitest';
import { shoppingLocationKey } from './interface-routing';
it('ignores only preview controls, preserving search, filters and navigation identity',()=>{
 const english=shoppingLocationKey('/search','?q=milk&min_price=10&interface_preview=en&interface_parent=https%3A%2F%2Fadmin.test&interface_channel=one');
 expect(shoppingLocationKey('/search','?q=milk&min_price=10&interface_preview=ar&interface_channel=two')).toBe(english);
 expect(shoppingLocationKey('/search','?q=milk&min_price=20')).not.toBe(english);
 expect(shoppingLocationKey('/cart','?q=milk&min_price=10')).not.toBe(english);
});
