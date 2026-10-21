import { expect, it, vi } from 'vitest';
import { clearComparisonReply } from './assistant-comparison';
it.each([0, 1, 5])('clears the shared selection before reporting the result (%s)', removed => {
  const clear = vi.fn(() => ({removed, persisted: true}));
  const reply = clearComparisonReply({clear});
  expect(clear).toHaveBeenCalledOnce();
  expect(reply.cleared).toBe(true);
  expect(reply.text).toContain('now empty');
  if (removed) expect(reply.text).toContain(`Removed ${removed} ${removed === 1 ? 'product' : 'products'}`);
});
it('does not claim completion when comparison is absent or clearing failed', () => {
  expect(clearComparisonReply(null).cleared).toBe(false);
  expect(clearComparisonReply({clear: () => { throw Error('unavailable'); }}).cleared).toBe(false);
});
it('reports a persistence failure while reflecting the cleared in-memory list', () => {
  const reply = clearComparisonReply({clear: () => ({removed: 2, persisted: false})});
  expect(reply.cleared).toBe(true);
  expect(reply.text).toContain('may return after a refresh');
});
