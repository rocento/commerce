import { CommerceError, type CommerceClient, type LiveProduct, type Locale } from './commerce';
import { FeatureState } from './featureState';
export type WishlistState = Readonly<{ ids: string[]; products: Record<string, LiveProduct | null>; limit: number; loaded: boolean; loading: boolean; failed: boolean; locale?: Locale }>;
const initial = (): WishlistState => ({ ids: [], products: {}, limit: 24, loaded: false, loading: false, failed: false });
export class WishlistStore extends FeatureState<WishlistState> {
  constructor(private client: Pick<CommerceClient, 'wishlist' | 'product' | 'saveProduct' | 'locale'>) { super(initial()); }
  reset() { this.generation++; this.publish(initial()); }
  invalidate() { this.generation++; this.publish({ ...this.state, loaded: false, loading: false }); }
  private async run(operation: (revision: number) => Promise<void>) {
    const revision = ++this.generation; this.publish({ ...this.state, loading: true, failed: false });
    try { await operation(revision); }
    catch (error) { this.checkRevision(revision); this.publish({ ...this.state, failed: true }); throw error; }
    finally { if (revision === this.generation) this.publish({ ...this.state, loading: false }); }
  }
  async refreshIDs() {
    await this.run(async revision => {
      const ids = [...new Set(await this.client.wishlist())]; this.checkRevision(revision);
      this.publish({ ...this.state, ids, products: Object.fromEntries(Object.entries(this.state.products).filter(([id]) => ids.includes(id))) });
    });
  }
  async load(locale: Locale, more = false) {
    if (this.state.locale !== locale) this.publish({ ...this.state, locale, products: {}, loaded: false, limit: 24 });
    this.client.locale = locale;
    const limit = more ? this.state.limit + 24 : 24;
    await this.run(async revision => {
      const ids = [...new Set(await this.client.wishlist())]; this.checkRevision(revision);
      const products: Record<string, LiveProduct | null> = {};
      for (const id of ids.slice(0, limit)) {
        try { const p = await this.client.product(id); products[id] = p.active === false ? null : p; }
        catch (e) { if (e instanceof CommerceError && e.status === 404) products[id] = null; else throw e; }
        this.checkRevision(revision);
      }
      this.publish({ ...this.state, ids, products, limit, loaded: true });
    });
  }
  async save(id: string, saved: boolean, product?: LiveProduct) {
    await this.run(async revision => {
      await this.client.saveProduct(id, saved); this.checkRevision(revision);
      const ids = this.state.ids.filter(value => value !== id), products = { ...this.state.products };
      if (saved) { ids.unshift(id); if (product) products[id] = product; } else delete products[id];
      this.publish({ ...this.state, ids, products });
    });
  }
}
