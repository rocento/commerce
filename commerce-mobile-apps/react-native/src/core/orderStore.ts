import type { CommerceClient, Order, OrderDetail } from './commerce';
import { FeatureState, OperationCancelled } from './featureState';
export interface OrderState {
  orders: Order[]; detail: OrderDetail | null; selectedID: string | null;
  loading: boolean; detailLoading: boolean; failed: boolean; detailFailed: boolean; loaded: boolean; hasMore: boolean;
}
const initial = (): OrderState => ({ orders: [], detail: null, selectedID: null, loading: false, detailLoading: false, failed: false, detailFailed: false, loaded: false, hasMore: true });
export class OrderStore extends FeatureState<OrderState> {
  private listRevision = 0;
  private detailRevision = 0;
  private offset = 0;
  constructor(private client: Pick<CommerceClient, 'orders' | 'order'>) { super(initial()); }
  reset() { this.listRevision++; this.detailRevision++; this.offset = 0; this.publish(initial()); }
  show(detail: OrderDetail | null) { this.detailRevision++; this.publish({ ...this.state, detail, selectedID: detail?.order.id ?? null, detailLoading: false, detailFailed: false }); }
  async refresh(more = false) {
    if (more && (this.state.loading || !this.state.hasMore)) return 0;
    const revision = ++this.listRevision;
    this.publish({ ...this.state, loading: true, failed: false });
    try {
      const page = await this.client.orders(more ? this.offset : 0);
      if (revision !== this.listRevision) throw new OperationCancelled();
      const ids = new Set<string>();
      const orders = [...(more ? this.state.orders : []), ...page].filter(value => !ids.has(value.id) && !!ids.add(value.id));
      this.offset = (more ? this.offset : 0) + page.length;
      this.publish({ ...this.state, orders, loading: false, loaded: true, hasMore: page.length > 0 });
      return page.length;
    } catch (error) {
      if (revision !== this.listRevision) throw new OperationCancelled();
      this.publish({ ...this.state, loading: false, failed: !(error instanceof OperationCancelled) }); throw error;
    }
  }
  async track(id: string) {
    const revision = ++this.detailRevision;
    this.publish({ ...this.state, selectedID: id, detail: this.state.selectedID === id ? this.state.detail : null, detailLoading: true, detailFailed: false });
    try {
      const detail = await this.client.order(id);
      if (revision !== this.detailRevision) throw new OperationCancelled();
      this.publish({ ...this.state, detail, detailLoading: false });
    } catch (error) {
      if (revision !== this.detailRevision) throw new OperationCancelled();
      this.publish({ ...this.state, detailLoading: false, detailFailed: !(error instanceof OperationCancelled) }); throw error;
    }
  }
}
