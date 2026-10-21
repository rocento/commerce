import { afterEach, expect, it, vi } from 'vitest';
import { AssistantStore } from './assistantStore';
import type { CommerceClient } from './commerce';

afterEach(() => vi.useRealTimers());
const setup = () => {
  vi.useFakeTimers();
  let emit!: Parameters<CommerceClient['streamAssistant']>[1];
  let finish!: () => void;
  let fail!: (error: Error) => void;
  const streamAssistant = vi.fn<CommerceClient['streamAssistant']>(async (_, event) => {
    emit = event;
    await new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  });
  const store = new AssistantStore({ assistantID: () => 'request', streamAssistant });
  const changed = vi.fn(), settled = vi.fn(async () => {}), checkout = vi.fn();
  store.subscribe(changed);
  const run = store.send('hello', { settled, checkout });
  let sequence = 0;
  return { store, changed, settled, checkout, run, streamAssistant,
    delta: (text: string) => emit({ version: '1', request_id: 'request', sequence: sequence++, type: 'message.delta', text }),
    done: () => { emit({ version: '1', request_id: 'request', sequence: sequence++, type: 'done' }); finish(); },
    fail: () => fail(new Error('connection lost')), finish: () => finish() };
};

it('coalesces text paints while preserving every delta and flushing completion immediately', async () => {
  const t = setup();
  for (let i = 0; i < 100; i++) t.delta('ع');
  expect(t.changed).toHaveBeenCalledTimes(1);
  expect(t.store.getBusySnapshot()).toBe(true);
  vi.advanceTimersByTime(32);
  expect(t.changed).toHaveBeenCalledTimes(2);
  expect(t.store.getSnapshot().turns[0]!.reply.text).toBe('ع'.repeat(100));
  t.delta('!'); t.done(); await t.run;
  expect(t.store.getSnapshot().turns[0]!.reply).toMatchObject({ text: 'ع'.repeat(100) + '!', completed: true });
  expect(t.store.getBusySnapshot()).toBe(false);
  expect(t.settled).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('retains unpainted text on interruption without replaying the request', async () => {
  const t = setup(); t.delta('partial'); t.fail(); await t.run;
  expect(t.store.getSnapshot().turns[0]).toMatchObject({ interrupted: true, reply: { text: 'partial', failed: true } });
  expect(t.streamAssistant).toHaveBeenCalledTimes(1);
  expect(t.checkout).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels a queued paint on reset so old text cannot reappear', async () => {
  const t = setup(); t.delta('old account'); t.store.reset();
  vi.advanceTimersByTime(100); t.finish(); await t.run;
  expect(t.store.getSnapshot().turns).toEqual([]);
  expect(t.settled).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
