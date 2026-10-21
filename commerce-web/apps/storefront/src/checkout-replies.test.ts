import { expect, it } from 'vitest';
import { checkoutReply } from './checkout-replies';
it('recognizes exact labels and replies to checkout controls', () => {
 expect(checkoutReply('Use my saved home address')).toBe('home');
 expect(checkoutReply('work')).toBe('work');
 expect(checkoutReply('pay cash on delivery')).toBe('cash');
 expect(checkoutReply('Yes!')).toBe('confirm');
 expect(checkoutReply('back')).toBe('back');
});
it.each(['do not confirm', 'yes if under 50', 'cash and add milk', 'use my home address except tomorrow', 'confirm; buy milk', 'yes\nadd bananas', 'confirm order 2', 'home or work', 'no', 'pay by card'])('leaves complex or unsupported reply with the language engine: %s', text => {
 expect(checkoutReply(text)).toBeNull();
});
