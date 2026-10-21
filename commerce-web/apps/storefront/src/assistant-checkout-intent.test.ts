import { expect, it } from 'vitest';
import { isCheckoutRequest } from './assistant-checkout-intent';

it.each([
  'checkout please', 'I want to checkout', 'checkout', 'please checkout',
  'plase checkout', 'checkout plase', 'Could you plase start checkout?',
  'PLASE CHECKOUT!',
  'I need to check out', 'I would like to checkout', "I'd like to check-out",
  "I'm ready to checkout", 'I am ready to checkout', 'im ready to checkout',
  'I wanna checkout', "let's checkout", 'lets checkout', 'help me checkout',
  'Can you open checkout?', 'Could you please start checkout?',
  'Proceed to checkout', 'Go to checkout', 'Take me to checkout',
  'Start my checkout', 'Open the checkout', 'Resume checkout', 'Continue checkout',
  'checkout now please', 'CHECKOUT!', '  checkout   please  ', 'check out plz',
  'create order', 'please place my order', 'start an order', 'pls create an order',
])('opens existing checkout for %s', message => {
  expect(isCheckoutRequest(message)).toBe(true);
});
it.each([
  "Don't checkout", 'do not checkout', 'cancel checkout', 'stop checkout',
  "plase don't checkout", 'plase cancel checkout',
  'plase checkout if delivery is free', 'plase checkout and remove the milk',
  'How does checkout work?', 'What is checkout?', 'checkout is broken',
  'I want to checkout after adding milk', 'checkout if delivery is free',
  'checkout and remove the milk', 'add milk then checkout', 'not ready to checkout',
  'create order 2 bananas', 'place an order for milk', 'show my order',
  'confirm order', 'yes', 'cash', 'continue to payment', 'I want a ticket', '',
])('keeps other messages in their existing flow: %s', message => {
  expect(isCheckoutRequest(message)).toBe(false);
});
