import { CommerceError, type Cart, type CommerceClient, type LiveProduct } from './commerce';
import { CheckoutFlow } from './checkout';
import { FeatureState } from './featureState';
type CartClient = Pick<CommerceClient, 'cart' | 'add' | 'quantity' | 'saveForLater' | 'coupon'>;
export class CartStore extends FeatureState<Cart | null> {
  constructor(private client: CartClient, private checkout: CheckoutFlow) { super(null); }
  reset() { this.generation++; this.publish(null); }
  accept(cart: Cart) { this.checkout.invalidate(); this.publish(cart); }
  async refresh() {
    const revision = this.generation; const cart = await this.client.cart(); this.checkRevision(revision); this.publish(cart);
  }
  async mutate(operation: () => Promise<Cart>) {
    if (this.checkout.locked) throw new CommerceError(409, 'Resolve the previous checkout first');
    const revision = this.generation; this.checkout.invalidate();
    const cart = await operation(); this.checkRevision(revision); this.publish(cart);
  }
  add(product: LiveProduct, quantity = 1) { return this.mutate(() => this.client.add(product, quantity)); }
  quantity(id: string, quantity: number) { return this.mutate(() => this.client.quantity(id, quantity)); }
  saveForLater(id: string) { return this.mutate(() => this.client.saveForLater(id)); }
  coupon(code: string) { return this.mutate(() => this.client.coupon(code)); }
}
