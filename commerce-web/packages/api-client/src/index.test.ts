import { afterEach, expect, it, vi } from 'vitest';
import { getHealth } from './index';
afterEach(() => vi.unstubAllGlobals());
it('accepts the gateway health contract', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"status":"ok"}')));
  await expect(getHealth()).resolves.toEqual({ status: 'ok' });
});
it('rejects malformed health responses', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"status":"broken"}')));
  await expect(getHealth()).rejects.toThrow('Unexpected gateway health response');
});
it('rejects gateway failures', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
  await expect(getHealth()).rejects.toThrow('503');
});
