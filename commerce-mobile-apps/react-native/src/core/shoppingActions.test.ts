import { describe, it, expect, vi } from 'vitest';
import fixture from '../../../shared/testing/commerce-flow.json';
import { CommerceClient } from './commerce';
import { ShoppingSession } from './shoppingSession';
import { OperationCancelled } from './featureState';

function setup() {
  const client = new CommerceClient(async () => { throw new Error('Unexpected request'); }, { get: async () => null, set: async () => {} }, () => 'fixture');
  const session = new ShoppingSession(client);
  vi.spyOn(client, 'login').mockResolvedValue(fixture.customer);
  vi.spyOn(client, 'place').mockResolvedValue(fixture.detail);
  vi.spyOn(client, 'cart').mockResolvedValue(fixture.cart);
  vi.spyOn(client, 'orders').mockResolvedValue([fixture.order]);
  return { client, session };
}
describe('cross-feature actions', () => {
  it('publishes order confirmation before a failed follow-up without placing twice', async () => {
    const { client, session } = setup();
    session.checkout.restore(fixture.quote);
    vi.mocked(client.cart).mockRejectedValue(new Error('offline'));
    const ok = await session.perform(() => session.actions.place(() => session.feedback.setNotice('Confirmed')));
    expect(ok).toBe(false); expect(session.feedback.getSnapshot().notice).toBe('Confirmed');
    expect(session.orders.getSnapshot().detail).toEqual(fixture.detail);
    expect(session.checkout.getSnapshot().phase).toBe('completed');
    expect(client.place).toHaveBeenCalledTimes(1); expect(client.orders).not.toHaveBeenCalled();
  });
  it('stops follow-ups when confirmation changes identity', async () => {
    const { client, session } = setup(); session.checkout.restore(fixture.quote);
    await expect(session.actions.place(() => session.account.reset())).rejects.toBeInstanceOf(OperationCancelled);
    expect(client.cart).not.toHaveBeenCalled(); expect(session.orders.getSnapshot().detail).toBeNull();
  });
  it('saves guest delivery without an authenticated cart read', async () => {
    const { client, session } = setup();
    vi.spyOn(client, 'coverage').mockResolvedValue({ configured: true, deliverable: true });
    const save = vi.spyOn(client, 'saveLocation');
    session.delivery.editAddress({ address: 'Guest', latitude: '30', longitude: '31' });
    await session.actions.saveAddress();
    expect(session.delivery.getSnapshot().guestAddress).toBe('Guest');
    expect(client.cart).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled();
  });
  it('does not refresh cart after rejected or stale delivery selection', async () => {
    const { client, session } = setup();
    vi.spyOn(client, 'coverage').mockResolvedValue({ configured: true, deliverable: false });
    await expect(session.actions.choose(fixture.location)).rejects.toThrow('Outside');
    expect(client.cart).not.toHaveBeenCalled();
    vi.mocked(client.coverage).mockImplementation(async () => { session.account.reset(); return { configured: true, deliverable: true }; });
    await expect(session.actions.choose(fixture.location)).rejects.toBeInstanceOf(OperationCancelled);
    expect(client.cart).not.toHaveBeenCalled();
  });
  it('publishes authentication before recovery errors so secrets can be cleared', async () => {
    const { client, session } = setup();
    vi.spyOn(client, 'pending').mockResolvedValue(null);
    vi.spyOn(client, 'locations').mockRejectedValue(new Error('offline'));
    const authenticated = vi.fn();
    await expect(session.actions.login('fixture', 'test', authenticated)).rejects.toThrow('offline');
    expect(authenticated).toHaveBeenCalledOnce(); expect(session.account.getSnapshot().customer).toEqual(fixture.customer);
  });
  it('still clears the account if push unregistration fails', async () => {
    const { client, session } = setup(); await session.account.login('fixture','test');
    vi.spyOn(client, 'logout').mockResolvedValue();
    await expect(session.actions.logout(async () => { expect(session.account.getSnapshot().customer).not.toBeNull(); throw new Error('push'); })).rejects.toThrow('push');
    expect(session.account.getSnapshot().customer).toBeNull(); expect(client.logout).toHaveBeenCalledOnce();
  });
  it('applies assistant proposals once and invalidates wishlist state', async () => {
    const { client, session } = setup();
    vi.spyOn(client, 'applyAssistantProposal').mockResolvedValue(fixture.cart);
    const invalidate = vi.spyOn(session.wishlist, 'invalidate');
    await session.actions.applyProposal('proposal');
    expect(client.applyAssistantProposal).toHaveBeenCalledOnce(); expect(session.cart.getSnapshot()).toEqual(fixture.cart);
    expect(invalidate).toHaveBeenCalledOnce();
  });
  it('skips guest assistant refresh and stops stale wishlist follow-ups', async () => {
    const { client, session } = setup(); await session.actions.assistantSettled();
    expect(client.cart).not.toHaveBeenCalled();
    await session.account.login('fixture','test');
    const wishlist = vi.spyOn(session.wishlist,'refreshIDs');
    vi.mocked(client.cart).mockImplementation(async () => { session.account.reset(); return fixture.cart; });
    await expect(session.actions.assistantSettled()).rejects.toBeInstanceOf(OperationCancelled);
    expect(wishlist).not.toHaveBeenCalled();
  });
  it('does not recover another session after authentication callbacks', async () => {
    const { client, session } = setup();
    const pending = vi.spyOn(client,'pending');
    await expect(session.actions.login('fixture','test', () => session.account.reset())).rejects.toBeInstanceOf(OperationCancelled);
    expect(pending).not.toHaveBeenCalled();
  });
  it('routes configurable assistant products and rejects unavailable products without adding', async () => {
    const { client, session } = setup();
    const product = { id: fixture.location.id, name: 'Product', price: '10', currency: 'EGP', description: '', in_stock: true, product_type: 'configurable' };
    vi.spyOn(client,'product').mockResolvedValue(product);
    const add = vi.spyOn(client,'add'), open = vi.fn(async () => {}), added = vi.fn();
    await session.actions.addAssistantProduct(product.id,open,added);
    expect(open).toHaveBeenCalledWith(product.id); expect(add).not.toHaveBeenCalled();
    vi.mocked(client.product).mockResolvedValue({ ...product, product_type: 'simple', in_stock: false });
    await expect(session.actions.addAssistantProduct(product.id,open,added)).rejects.toThrow('no longer available');
    expect(add).not.toHaveBeenCalled(); expect(added).not.toHaveBeenCalled();
  });

});
