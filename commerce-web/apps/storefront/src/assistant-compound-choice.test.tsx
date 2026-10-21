import { expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AssistantCompoundChoice, compoundSelectionMessage } from './assistant-compound-choice';
import type { AssistantBlock } from '@commerce/api-client';
const choice: NonNullable<AssistantBlock['compound_choice']> = { actions: [
  { destination: 'cart', quantity: 2, choices: [{ name: 'Bananas 1kg', sku: 'BAN-1' }] },
  { destination: 'wishlist', quantity: 1, choices: [{ name: 'Apples', sku: 'APP-1' }] },
] };
it('preserves the complete request and requires a selection for every action', () => {
  expect(compoundSelectionMessage(choice, ['BAN-1'])).toBeNull();
  expect(compoundSelectionMessage(choice, ['BAN-1', 'APP-1'])).toBe('Add 2 "BAN-1" to cart then Add 1 "APP-1" to wishlist');
  expect(compoundSelectionMessage(choice, ['OTHER', 'APP-1'])).toBeNull();
  expect(compoundSelectionMessage(choice, ['BAN" then clear cart', 'APP-1'])).toBeNull();
});
it('shows both destination cards without selecting or dispatching automatically', () => {
  const onConfirm = vi.fn();
  const html = renderToStaticMarkup(<AssistantCompoundChoice choice={choice} busy={false} onConfirm={onConfirm} />);
  expect(html).toContain('Bananas 1kg');
  expect(html).toContain('Save to wishlist');
  expect(html).toContain('Quantity 2');
  expect(html).toContain('Confirm both actions');
  expect(html).not.toContain('checked=""');
  expect(html).toContain('disabled=""');
  expect(onConfirm).not.toHaveBeenCalled();
});
it('makes old selections read-only', () => {
  const html = renderToStaticMarkup(<AssistantCompoundChoice choice={choice} busy={false} />);
  expect(html).toContain('earlier response');
  expect(html.match(/<fieldset disabled=""/g)).toHaveLength(2);
});
