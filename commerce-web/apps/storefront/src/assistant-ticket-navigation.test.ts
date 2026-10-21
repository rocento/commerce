import { expect, it } from 'vitest';
import { assistantSessionParams, assistantTicketLink } from './assistant-ticket-navigation';
it('keeps the same session when switching tickets, including a restored conversation', () => {
 for (const query of ['', 'conversation=history-id']) {
  const params = new URLSearchParams(query);
  const original = assistantSessionParams(params);
  for (const id of ['ticket-one','ticket-two']) {
   const next = new URL(assistantTicketLink(params,id),'https://example.test').searchParams;
   expect(assistantSessionParams(next)).toBe(original);
   expect(next.get('ticket')).toBe(id);
   expect(next.get('conversation')).toBe(params.get('conversation'));
  }
  expect(params.toString()).toBe(query);
 }
});
it('still isolates different saved conversations', () => {
 expect(assistantSessionParams(new URLSearchParams('conversation=one&ticket=a'))).not.toBe(assistantSessionParams(new URLSearchParams('conversation=two&ticket=a')));
});
it('keeps the chat mounted when clearing a comparison link', () => {
 const before = new URLSearchParams('conversation=one&compare=product-one,product-two');
 const after = new URLSearchParams('conversation=one');
 expect(assistantSessionParams(before)).toBe(assistantSessionParams(after));
});
