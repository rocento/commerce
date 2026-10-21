import { CommerceError, type CommerceClient, type Location } from './commerce';
import type { ShoppingSession } from './shoppingSession';
import { OperationCancelled } from './featureState';

type Stores = Pick<ShoppingSession, 'account' | 'cart' | 'delivery' | 'checkout' | 'orders' | 'wishlist' | 'workflows'>;
/** Runs inside the existing session gate. UI callbacks only publish presentation. */
export class ShoppingActions {
  constructor(private client: CommerceClient, private stores: Stores, private revision: () => number) {}
  private check(expected: number) { if (expected !== this.revision()) throw new OperationCancelled(); }
  async place(confirmed: (order: Awaited<ReturnType<Stores['checkout']['place']>>) => void) {
    const expected = this.revision();
    const order = await this.stores.checkout.place();
    this.check(expected);
    this.stores.orders.show(order);
    confirmed(order);
    this.check(expected);
    await this.stores.cart.refresh();
    this.check(expected);
    await this.stores.orders.refresh();
  }
  async choose(value: Location) {
    const expected = this.revision();
    await this.stores.delivery.choose(value);
    this.check(expected);
    await this.stores.cart.refresh();
    this.check(expected);
  }
  async saveAddress() {
    const expected = this.revision(); const guest = !this.stores.account.getSnapshot().customer;
    await this.stores.delivery.saveAddress(guest);
    this.check(expected);
    if (!guest) { await this.stores.cart.refresh(); this.check(expected); }
  }
  async applyProposal(id: string) {
    const expected = this.revision();
    await this.stores.cart.mutate(() => this.client.applyAssistantProposal(id));
    this.check(expected);
    this.stores.wishlist.invalidate();
  }
  async assistantSettled() {
    if (!this.stores.account.getSnapshot().customer) return;
    const expected = this.revision();
    this.stores.checkout.invalidate(); this.stores.wishlist.invalidate();
    await this.stores.cart.refresh();
    this.check(expected);
    await this.stores.wishlist.refreshIDs();
    this.check(expected);
  }
  async addAssistantProduct(id: string, openProduct: (id: string) => Promise<void>, added: () => void) {
    const expected = this.revision();
    const product = await this.client.product(id);
    this.check(expected);
    if (product.product_type === 'configurable') { await openProduct(id); return; }
    if (!product.in_stock) throw new CommerceError(409, 'This product is no longer available');
    await this.stores.cart.add(product);
    this.check(expected); added();
  }
  async login(identifier: string, password: string, authenticated: () => void = () => {}) {
    await this.stores.account.login(identifier, password);
    const expected = this.revision();
    authenticated();
    this.check(expected);
    await this.stores.workflows.reload();
  }
  async auth(...args: Parameters<Stores['account']['auth']>) {
    await this.stores.account.auth(...args);
    if (args[0] === 'verify' && this.stores.account.getSnapshot().customer) await this.stores.workflows.reload();
  }
  async logout(beforeLogout: () => Promise<void> = async () => {}) {
    try { await beforeLogout(); } finally { await this.stores.account.logout(); }
  }
}
