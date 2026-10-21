import { CommerceError, type Category, type CommerceClient, type LiveProduct, type Locale } from './commerce';
import { emptyFilters, type CatalogFilters } from './catalogFilters';
import { FeatureState, OperationCancelled } from './featureState';

type CatalogClient = Pick<CommerceClient, 'categories' | 'search' | 'product' | 'family' | 'locale' | 'pin'>;
export type CatalogState = Readonly<{
  categories: Category[]; products: LiveProduct[]; total: number; offset: number; hasMore: boolean;
  query: string; category: string; filters: CatalogFilters; loading: boolean; error: string;
  selected: LiveProduct | null; variants: LiveProduct[]; productLoading: boolean;
}>;
const initial = (): CatalogState => ({ categories: [], products: [], total: 0, offset: 0, hasMore: false,
  query: '', category: '', filters: { ...emptyFilters }, loading: false, error: '', selected: null, variants: [], productLoading: false });
export class CatalogStore extends FeatureState<CatalogState> {
  private request = 0;
  private productRequest = 0;
  private controller?: AbortController;
  constructor(private client: CatalogClient) { super(initial()); }
  update(change: Partial<Pick<CatalogState, 'query' | 'category' | 'filters'>>) {
    this.cancel(); this.publish({ ...this.state, ...change, products: [], total: 0, offset: 0, hasMore: false, error: '' });
  }
  cancel() { this.request++; this.controller?.abort(); this.publish({ ...this.state, loading: false }); }
  reset() { this.cancel(); this.productRequest++; this.publish(initial()); }
  dismissProduct() { this.productRequest++; this.publish({ ...this.state, selected: null, variants: [], productLoading: false }); }
  async refresh(locale: Locale, more = false) {
    if (more && (this.state.loading || !this.state.hasMore)) return;
    this.cancel(); const revision = this.request, controller = new AbortController(); this.controller = controller;
    this.client.locale = locale;
    const { query, category, filters } = this.state, offset = more ? this.state.offset : 0;
    this.publish({ ...this.state, loading: true, error: '', ...(more ? {} : { products: [], total: 0, offset: 0, hasMore: false }) });
    try {
      const [categories, page] = await Promise.all([this.client.categories(controller.signal), this.client.search(query, category, offset, controller.signal, filters)]);
      if (revision !== this.request || controller.signal.aborted) return;
      const products = more ? [...this.state.products] : [];
      const seen = new Set(products.map(product => product.id));
      for (const product of page.hits) if (product.active !== false && !seen.has(product.id)) { products.push(product); seen.add(product.id); }
      const next = offset + page.hits.length;
      this.publish({ ...this.state, categories, products, total: page.total, offset: next, hasMore: page.hits.length > 0 && next < page.total && next <= 9999 });
    } catch (error) {
      if (revision === this.request && !controller.signal.aborted) this.publish({ ...this.state, error: error instanceof CommerceError ? error.message : locale === 'ar' ? 'الكتالوج غير متاح. تحقق من الاتصال وحاول مرة أخرى.' : 'Catalog unavailable. Check your connection and retry.' });
    } finally { if (revision === this.request) { this.controller = undefined; this.publish({ ...this.state, loading: false }); } }
  }
  async openProduct(id: string) {
    const revision = ++this.productRequest, locale = this.client.locale;
    this.publish({ ...this.state, selected: null, variants: [], productLoading: true });
    const check = () => { if (revision !== this.productRequest || locale !== this.client.locale) throw new OperationCancelled(); };
    try {
      const selected = await this.client.product(id); check();
      this.publish({ ...this.state, selected });
      if (selected.product_type === 'configurable' && this.client.pin) {
        const family = await this.client.family(id); check();
        this.publish({ ...this.state, variants: family.children.filter(p => p.active !== false) });
      }
    } catch (error) { check(); throw error; }
    finally { if (revision === this.productRequest) this.publish({ ...this.state, productLoading: false }); }
  }
}
