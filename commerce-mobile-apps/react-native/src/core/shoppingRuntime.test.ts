import { describe, expect, it, vi } from 'vitest';
import fixture from '../../../shared/testing/commerce-flow.json';
import { CommerceClient, type Storage } from './commerce';
import { ShoppingRuntime } from './shoppingRuntime';

function setup(preferences?: Storage) {
  const client = new CommerceClient(async () => { throw new Error('Unexpected network'); }, { get: async () => null, set: async () => {} }, () => 'fixture');
  return { client, runtime: new ShoppingRuntime(client, preferences) };
}
describe('runtime ownership', () => {
  it('owns form secrets across navigation and identity changes without duplicate publishes', async () => {
    const { client, runtime } = setup();
    runtime.session.navigation.open('auth');
    runtime.authForm.edit({ identifier: 'person', password: 'secret', code: '123' });
    const changed = vi.fn(); runtime.authForm.subscribe(changed);
    runtime.session.account.reset(); // Resets navigation and identity in one transition.
    expect(changed).toHaveBeenCalledOnce();
    expect(runtime.authForm.getSnapshot()).toMatchObject({ identifier: 'person', password: '', code: '' });
    runtime.session.navigation.open(null); expect(changed).toHaveBeenCalledOnce();
    vi.spyOn(client,'login').mockResolvedValue(fixture.customer);
    await runtime.session.account.login('person','secret');
    expect(runtime.authForm.getSnapshot().password).toBe('');
  });
  it('owns locale propagation and restores account even when preferences fail', async () => {
    const { client, runtime } = setup({ get: async () => { throw new Error('preference unavailable'); }, set: async () => {} });
    const restore = vi.spyOn(client,'restore').mockResolvedValue(null);
    await runtime.start(); expect(restore).toHaveBeenCalledOnce();
    await runtime.settings.selectLocale('ar'); expect(client.locale).toBe('ar');
  });
  it('prevents disposed startup from recovering an account and reconnects once on restart', async () => {
    let release!: (value: string | null) => void;
    const gate = new Promise<string | null>(resolve => { release = resolve; });
    const { client, runtime } = setup({ get: () => gate, set: async () => {} });
    const restore = vi.spyOn(client,'restore').mockResolvedValue(null);
    const starting = runtime.start(); runtime.dispose(); release('ar'); await starting;
    expect(restore).not.toHaveBeenCalled();
    await runtime.start(); expect(restore).toHaveBeenCalledOnce(); expect(client.locale).toBe('ar');
    runtime.session.navigation.open('auth'); runtime.authForm.edit({ password: 'secret' });
    const changed = vi.fn(); runtime.authForm.subscribe(changed);
    runtime.session.navigation.back(); expect(changed).toHaveBeenCalledOnce();
  });
  it('resets order state once when leaving an order through an identity reset', () => {
    const { runtime } = setup();
    runtime.session.navigation.open('order'); runtime.session.orders.show(fixture.detail);
    const changed = vi.fn(); runtime.session.orders.subscribe(changed);
    runtime.session.account.reset();
    expect(changed).toHaveBeenCalledOnce(); expect(runtime.session.orders.getSnapshot().detail).toBeNull();
  });
});
