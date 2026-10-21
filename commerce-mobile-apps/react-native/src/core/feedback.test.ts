import { describe, expect, it } from 'vitest';
import { CommerceError } from './commerce';
import { FeedbackStore, mapFailure } from './feedbackStore';
import { OperationCoordinator } from './operations';
import { OperationCancelled } from './featureState';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
describe('feedback and loading', () => {
  it('classifies commerce failures and hides unknown diagnostics', () => {
    for (const [status, kind] of [[422, 'validation'], [401, 'authentication'], [403, 'permission'], [409, 'conflict'], [429, 'rateLimit'], [503, 'server']] as const) {
      expect(mapFailure(new CommerceError(status, 'safe message'))).toEqual({ kind, status, message: 'safe message' });
    }
    expect(mapFailure(new Error('private debug data'))?.message).not.toContain('private');
    expect(mapFailure(new TypeError('network'), 'ar')).toMatchObject({ kind: 'connection', message: 'تعذر الاتصال. تحقق من اتصالك وحاول مرة أخرى.' });
    expect(mapFailure(new OperationCancelled())).toBeNull();
    const abort = new Error('aborted'); abort.name = 'AbortError'; expect(mapFailure(abort)).toBeNull();
  });
  it('publishes authentication failure after identity reset and never retries', async () => {
    const feedback = new FeedbackStore(), queue = new OperationCoordinator(); let resets = 0, calls = 0;
    const result = await feedback.perform(queue, async () => { calls++; throw new CommerceError(401, 'Sign in'); }, { onUnauthorized: () => { resets++; feedback.clear(); } });
    expect(result).toBe(false); expect(calls).toBe(1); expect(resets).toBe(1);
    expect(feedback.getSnapshot().failure?.kind).toBe('authentication'); expect(queue.busy).toBe(false);
  });
  it('preserves a successful write notice when its follow-up refresh fails', async () => {
    const feedback = new FeedbackStore(), queue = new OperationCoordinator();
    await feedback.perform(queue, async () => { feedback.setNotice('Order confirmed'); throw new CommerceError(503, 'History unavailable'); });
    expect(feedback.getSnapshot()).toMatchObject({ notice: 'Order confirmed', failure: { kind: 'server' } });
    feedback.setError(null); expect(feedback.getSnapshot().failure).toBeNull(); expect(feedback.getSnapshot().notice).toBe('Order confirmed');
    feedback.setNotice(null); expect(feedback.getSnapshot().notice).toBeNull();
    await feedback.perform(queue, async () => { feedback.setNotice('Order confirmed'); throw new CommerceError(401, 'Sign in'); }, { onUnauthorized: () => feedback.clear() });
    expect(feedback.getSnapshot()).toMatchObject({ notice: 'Order confirmed', failure: { kind: 'authentication' } });
  });
  it('keeps feedback until a queued operation starts and tracks loading kind', async () => {
    const feedback = new FeedbackStore(), queue = new OperationCoordinator(), gate = deferred();
    const first = feedback.perform(queue, async () => { feedback.setNotice('Refreshing orders'); await gate.promise; }, { kind: 'refresh' });
    await Promise.resolve(); await Promise.resolve();
    const next = feedback.perform(queue, async () => {
      expect(feedback.getSnapshot().notice).toBeNull(); expect(queue.getSnapshot().kind).toBe('mutation');
    });
    expect(feedback.getSnapshot().notice).toBe('Refreshing orders'); expect(queue.getSnapshot()).toMatchObject({ active: true, queued: 1, kind: 'refresh' });
    gate.resolve(); await Promise.all([first, next]); expect(queue.getSnapshot()).toEqual({ active: false, queued: 0, kind: null, busy: false });
  });
  it('cancels queued work without clearing current feedback or leaking busy state', async () => {
    const feedback = new FeedbackStore(), queue = new OperationCoordinator(), gate = deferred(); let calls = 0;
    const active = feedback.perform(queue, async () => { await gate.promise; feedback.setNotice('Finished'); }, { kind: 'initial' });
    await Promise.resolve(); const queued = feedback.perform(queue, async () => { calls++; });
    queue.invalidatePending(); gate.resolve(); await active; expect(await queued).toBe(false);
    expect(calls).toBe(0); expect(feedback.getSnapshot()).toEqual({ failure: null, notice: 'Finished' }); expect(queue.busy).toBe(false);
  });
  it('silences cancellation and resets feedback before a new action', async () => {
    const feedback = new FeedbackStore(), queue = new OperationCoordinator(); feedback.setError('old'); feedback.setNotice('old');
    expect(await feedback.perform(queue, async () => { throw new OperationCancelled(); })).toBe(false);
    expect(feedback.getSnapshot()).toEqual({ failure: null, notice: null }); expect(queue.busy).toBe(false);
  });
});
