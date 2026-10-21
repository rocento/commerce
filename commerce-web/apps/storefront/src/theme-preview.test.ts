import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTheme } from '@commerce/api-client';
import { receiveThemePreview } from './theme-preview';
let frame: EventTarget & {parent: {postMessage: ReturnType<typeof vi.fn>}; setTimeout: typeof setTimeout};
const origin = 'https://admin.example.test';
const data = () => ({type:'rocento:theme-preview-config',themeId:'theme',channel:'nonce',configuration:defaultTheme()});
function send(patch: Record<string, unknown> = {}, payload = data()) {
  frame.dispatchEvent(Object.assign(new Event('message'), {origin,source:frame.parent,data:payload,...patch}));
}
beforeEach(() => { vi.useFakeTimers(); frame = Object.assign(new EventTarget(), {parent:{postMessage:vi.fn()},setTimeout}); vi.stubGlobal('window', frame); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('draft preview frame handshake', () => {
  it('requires the exact parent window, origin, theme and channel before accepting a draft', async () => {
    let delivered = false;
    const result = receiveThemePreview('theme',origin,'nonce',new AbortController().signal).then(config => {delivered=true;return config;});
    expect(frame.parent.postMessage).toHaveBeenCalledWith({type:'rocento:theme-preview-ready',themeId:'theme',channel:'nonce'},origin);
    send({origin:'https://attacker.example.test'}); send({source:{}});
    send({}, {...data(),channel:'other'}); send({}, {...data(),themeId:'other'});
    await Promise.resolve(); expect(delivered).toBe(false);
    send(); await expect(result).resolves.toEqual(defaultTheme());
  });
  it('validates received configuration before rendering', async () => {
    const result=receiveThemePreview('theme',origin,'nonce',new AbortController().signal);
    send({data:{...data(),configuration:{}}});
    await expect(result).rejects.toThrow('invalid');
  });
  it('times out with an accurate error instead of an authorization message', async () => {
    const result=receiveThemePreview('theme',origin,'nonce',new AbortController().signal);
    const assertion=expect(result).rejects.toThrow('did not respond');
    await vi.advanceTimersByTimeAsync(15000); await assertion;
  });
  it('cleans up an aborted frame request', async () => {
    const controller=new AbortController();
    const result=receiveThemePreview('theme',origin,'nonce',controller.signal);controller.abort();
    await expect(result).rejects.toThrow('cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('rejects invalid parent origins', async () => {
    await expect(receiveThemePreview('theme','javascript:alert(1)','nonce',new AbortController().signal)).rejects.toThrow('invalid');
    expect(frame.parent.postMessage).not.toHaveBeenCalled();
  });
});
