import { describe, expect, it } from 'vitest';
import { AuthenticationForm } from './authenticationForm';
import { AppSettingsStore } from './appSettingsStore';
describe('authentication form', () => {
  it('validates byte length and preserves legacy sign in', () => {
    const form = new AuthenticationForm(); form.open('register');
    form.edit({ identifier: 'person', password: 'ع'.repeat(6), confirmation: 'ع'.repeat(6) });
    expect(form.prepare()).not.toBeNull();
    form.edit({ password: 'ع'.repeat(65) }); expect(form.prepare()).toBeNull(); expect(form.getSnapshot().validation).toBe('length');
    form.open('login'); form.edit({ password: 'old' }); expect(form.prepare()).not.toBeNull();
  });
  it('clears all secrets on success and rejects a stale completion', () => {
    const form = new AuthenticationForm(); form.open('register'); form.edit({ identifier: 'person', password: 'long password', confirmation: 'long password', showPassword: true });
    const submitted = form.prepare()!; expect(form.complete(submitted)).toBe(true);
    expect(form.getSnapshot()).toMatchObject({ mode: 'verify', identifier: 'person', password: '', confirmation: '', showPassword: false });
    form.edit({ code: '123456' }); const verifying = form.prepare()!; form.clearSecrets();
    expect(form.complete(verifying)).toBe(false); expect(form.getSnapshot().code).toBe('');
  });
  it('requires matching confirmation and verification code', () => {
    const form = new AuthenticationForm(); form.open('reset-password'); form.edit({ identifier: 'person', password: 'long password' });
    expect(form.prepare()).toBeNull(); expect(form.getSnapshot().validation).toBe('confirmation');
    form.edit({ confirmation: 'long password' }); expect(form.prepare()).toBeNull(); expect(form.getSnapshot().validation).toBe('code');
  });
});
describe('app settings', () => {
  it('restores and persists language', async () => {
    let saved = 'ar'; const store = new AppSettingsStore({ get: async () => saved, set: async (_, value) => { saved = value!; } });
    await store.restore(); expect(store.getSnapshot().locale).toBe('ar');
    await store.selectLocale('en'); expect(saved).toBe('en');
  });
  it('retains the previous locale when persistence fails', async () => {
    const store = new AppSettingsStore({ get: async () => null, set: async () => { throw Error('offline'); } });
    await expect(store.selectLocale('ar')).rejects.toThrow(); expect(store.getSnapshot().locale).toBe('en');
  });
  it('ignores stale startup restoration after a selection', async () => {
    let resolve!: (value: string) => void;
    const store = new AppSettingsStore({ get: () => new Promise(r => { resolve = r; }), set: async () => {} });
    const restore = store.restore(); await store.selectLocale('ar'); resolve('en'); await restore;
    expect(store.getSnapshot().locale).toBe('ar');
  });
});
