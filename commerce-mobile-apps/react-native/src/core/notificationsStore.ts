import type { CommerceClient, OrderDetail, Storage } from './commerce';
import { FeatureState } from './featureState';
export type InboxUpdate = { id: string; order: string; number: number; status: string; date: string };
type State = { owner: string | null; details: OrderDetail[]; read: string[]; enabled: boolean; unreadOnly: boolean; loading: boolean; loaded: boolean; failed: boolean; ready: boolean; offset: number; hasMore: boolean };
const initial = (): State => ({ owner: null, details: [], read: [], enabled: true, unreadOnly: false, loading: false, loaded: false, failed: false, ready: false, offset: 0, hasMore: false });
export const memoryNotificationStorage = (): Storage => { const values = new Map<string, string>(); return { get: async key => values.get(key) ?? null, set: async (key, value) => { if (value === null) values.delete(key); else values.set(key, value); } }; };
export class NotificationsStore extends FeatureState<State> {
  private binding?: Promise<void>;
  constructor(private client: Pick<CommerceClient, 'orders' | 'order'>, private storage: Storage = memoryNotificationStorage()) { super(initial()); }
  reset() { this.generation++; this.binding = undefined; this.publish(initial()); }
  async bind(owner: string | null) {
    if (this.state.owner === owner && this.state.ready) return;
    if (this.state.owner === owner && this.binding) return this.binding;
    this.reset(); const revision = this.generation; this.publish({ ...this.state, owner });
    const binding = (async () => {
      try {
        const [enabled, saved] = await Promise.all([this.storage.get('orderUpdates'), owner ? this.storage.get(`notificationRead.${owner}`) : Promise.resolve(null)]);
        this.checkRevision(revision);
        const parsed: unknown = saved ? JSON.parse(saved) : [];
        const read = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
        this.publish({ ...this.state, enabled: enabled !== 'false', read, ready: true, failed: false });
      } catch (error) { this.checkRevision(revision); this.publish({ ...this.state, failed: true }); throw error; }
      finally { if (revision === this.generation) this.binding = undefined; }
    })();
    this.binding = binding; return binding;
  }
  get events(): InboxUpdate[] {
    const seen = new Set<string>();
    return this.state.details.flatMap(detail => detail.history.map(value => ({ id: `${detail.order.id}:${value.id}`, order: detail.order.id, number: detail.order.number, status: value.status, date: value.created_at })))
      .filter(value => { if (seen.has(value.id)) return false; seen.add(value.id); return true; })
      .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  }
  get unread() { return this.events.filter(value => !this.state.read.includes(value.id)); }
  filterUnread(unreadOnly: boolean) { this.publish({ ...this.state, unreadOnly }); }
  async mark(ids: string[]) {
    if (!this.state.owner || !this.state.ready) return;
    const revision = this.generation, owner = this.state.owner, valid = new Set(this.events.map(value => value.id));
    const read = [...new Set([...this.state.read, ...ids.filter(id => valid.has(id))])];
    await this.storage.set(`notificationRead.${owner}`, JSON.stringify(read)); this.checkRevision(revision);
    this.publish({ ...this.state, read });
  }
  async setEnabled(enabled: boolean) {
    await this.storage.set('orderUpdates', String(enabled)); this.generation++;
    this.publish({ ...this.state, enabled, loading: false });
  }
  async refresh(owner: string, more = false) {
    const binding = this.bind(owner), bindingRevision = this.generation;
    await binding; this.checkRevision(bindingRevision);
    if (!this.state.enabled || more && (!this.state.hasMore || this.state.loading)) return;
    const revision = ++this.generation, offset = more ? this.state.offset : 0;
    this.publish({ ...this.state, loading: true, failed: false });
    try {
      const orders = await this.client.orders(offset); this.checkRevision(revision);
      const details: OrderDetail[] = [];
      for (const order of orders) { details.push(await this.client.order(order.id)); this.checkRevision(revision); }
      const byID = new Map((more ? this.state.details : []).map(detail => [detail.order.id, detail]));
      for (const detail of details) byID.set(detail.order.id, detail);
      this.publish({ ...this.state, details: [...byID.values()], offset: offset + orders.length, hasMore: orders.length > 0 && offset + orders.length <= 9999, loaded: true });
    } catch (error) { this.checkRevision(revision); this.publish({ ...this.state, failed: true }); throw error; }
    finally { if (revision === this.generation) this.publish({ ...this.state, loading: false }); }
  }
}
