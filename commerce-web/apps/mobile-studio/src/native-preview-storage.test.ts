import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextPreviewInputSequence, readPreviewSession, writePreviewSession } from './native-preview-storage';

const key = 'rocento.preview-session:merchant-a:production';
const saved = { id: 'worker-session', expiresAt: '2030-01-01T00:30:00Z', target: 'react-native-android' as const };
let values: Map<string, string>;
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
  values = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
    removeItem: (name: string) => values.delete(name),
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('native preview refresh persistence', () => {
  it('restores the exact worker session and target, isolated by merchant and environment', () => {
    writePreviewSession(key, saved);
    expect(readPreviewSession(key)).toEqual(saved);
    expect(readPreviewSession('rocento.preview-session:merchant-b:production')).toBeUndefined();
    expect(readPreviewSession('rocento.preview-session:merchant-a:staging')).toBeUndefined();
    expect(readPreviewSession(key)).toEqual(saved);
  });
  it.each(['{', 'null', '[]', JSON.stringify({ ...saved, target: 'invalid' }), JSON.stringify({ ...saved, expiresAt: 'not-a-date' }), JSON.stringify({ ...saved, expiresAt: '2029-01-01' })])('discards malformed or expired stored sessions: %s', raw => {
    values.set(key, raw);
    expect(readPreviewSession(key)).toBeUndefined();
    expect(values.has(key)).toBe(false);
  });
  it('does not persist connection codes and clears the resume record on stop', () => {
    writePreviewSession(key, { ...saved, code: 'private-manual-code' } as typeof saved);
    expect(values.get(key)).not.toContain('private-manual-code');
    writePreviewSession(key);
    expect(readPreviewSession(key)).toBeUndefined();
  });
  it('keeps input sequence numbers increasing after reload, even if the clock moves backwards', () => {
    const first = nextPreviewInputSequence('input:a', 0);
    vi.setSystemTime(new Date('2029-12-31T23:59:00Z'));
    const afterReload = nextPreviewInputSequence('input:a', 0);
    expect(afterReload).toBeGreaterThan(first);
    expect(nextPreviewInputSequence('input:a', afterReload)).toBeGreaterThan(afterReload);
    expect(Number.isSafeInteger(afterReload)).toBe(true);
  });
  it('continues working when browser storage is blocked', () => {
    vi.stubGlobal('sessionStorage', { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } });
    expect(() => writePreviewSession(key, saved)).not.toThrow();
    expect(readPreviewSession(key)).toBeUndefined();
    const first = nextPreviewInputSequence('input:a', 0);
    expect(nextPreviewInputSequence('input:a', first)).toBeGreaterThan(first);
  });
});
