import type { LiveProduct } from './commerce';
import { FeatureState } from './featureState';
export class ProductPromptStore extends FeatureState<{ products: LiveProduct[]; selected: string[]; busy: boolean; failed: boolean }> {
  private controller?: AbortController;
  constructor() { super({ products: [], selected: [], busy: false, failed: false }); }
  reset() { this.generation++; this.controller?.abort(); this.publish({ products: [], selected: [], busy: false, failed: false }); }
  select(id: string) {
    if (!this.state.products.some(p => p.id === id)) return;
    this.publish({ ...this.state, selected: this.state.selected.includes(id) ? this.state.selected.filter(v => v !== id) : [...this.state.selected, id] });
  }
  async load(fetch: (signal: AbortSignal) => Promise<LiveProduct[]>) {
    this.reset(); const revision = this.generation, controller = new AbortController(); this.controller = controller;
    this.publish({ ...this.state, busy: true });
    try { const products = await fetch(controller.signal); if (revision === this.generation) this.publish({ ...this.state, products: products.filter(p => p.active !== false).slice(0, 8) }); }
    catch { if (revision === this.generation && !controller.signal.aborted) this.publish({ ...this.state, failed: true }); }
    finally { if (revision === this.generation) { this.controller = undefined; this.publish({ ...this.state, busy: false }); } }
  }
}
