import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NativePreviewSession } from './native-preview-session';

const key = 'rocento.preview-session:merchant-a:production';
let values: Map<string, string>;
beforeEach(() => {
  values = new Map();
  vi.stubGlobal('sessionStorage', { getItem: (name: string) => values.get(name) ?? null, removeItem: (name: string) => values.delete(name) });
  // A different tab may change the preferred platform; the running session wins.
  vi.stubGlobal('localStorage', { getItem: () => 'ios' });
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
const render = () => renderToStaticMarkup(<NativePreviewSession merchant="merchant-a" environment="production" savedRevision={7} hasLocalChanges={false} />);

describe('native preview initial render after refresh', () => {
  it('enables only React Native Android and shares the Android server controls', () => {
    vi.stubEnv('VITE_ANDROID_EC2_ENABLED', 'true');
    vi.stubEnv('VITE_IOS_PREVIEW_ENABLED', 'false');
    vi.stubEnv('VITE_RN_PREVIEW_ENABLED', 'false');
    vi.stubEnv('VITE_RN_ANDROID_PREVIEW_ENABLED', 'true');
    vi.stubGlobal('localStorage', { getItem: () => 'react-native-android' });
    const html = render();
    expect(html).toContain('aria-label="Android server controls"');
    expect(html).toContain('<option value="react-native-android" selected="">Android · React Native</option>');
    expect(html).toContain('<option value="react-native-ios" disabled="">');
    expect(html).toContain('<button type="button" disabled="">Open Android Preview</button>');
  });
  it('reconnects the existing Android React Native session instead of reverting to the preference', () => {
    values.set(key, JSON.stringify({ id: 'same-running-session', expiresAt: new Date(Date.now() + 60000).toISOString(), target: 'react-native-android' }));
    const html = render();
    expect(html).toContain('data-session="same-running-session"');
    expect(html).toContain('Interactive React Native Android preview');
    expect(html).toContain('Stop native preview');
    expect(html).not.toContain('Open iOS Preview');
  });
  it('does not reconnect an expired preview or select its old app', () => {
    values.set(key, JSON.stringify({ id: 'expired-session', expiresAt: new Date(Date.now() - 1000).toISOString(), target: 'react-native-android' }));
    const html = render();
    expect(html).not.toContain('<canvas');
    expect(html).toContain('Open iOS Preview');
    expect(values.has(key)).toBe(false);
  });
});


describe('unavailable saved preview targets', () => {
  it.each(['ios', 'react-native-ios', 'react-native-android'])('falls back from %s to hosted Android when unavailable', target => {
    vi.stubEnv('VITE_ANDROID_EC2_ENABLED', 'true');
    vi.stubEnv('VITE_IOS_PREVIEW_ENABLED', 'false');
    vi.stubEnv('VITE_RN_PREVIEW_ENABLED', 'false');
    vi.stubEnv('VITE_RN_ANDROID_PREVIEW_ENABLED', 'false');
    vi.stubGlobal('localStorage', { getItem: () => target });
    const html = render();
    expect(html).toContain('<option value="android" selected="">');
    expect(html).toContain('aria-label="Android server controls"');
    expect(html).not.toContain('Open iOS Preview');
  });
});
