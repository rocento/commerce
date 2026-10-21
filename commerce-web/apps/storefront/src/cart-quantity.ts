import type { Cart } from '@commerce/api-client';

type PendingQuantity = { quantity: number; limit: number };
type Snapshot = {
  pending: Readonly<Record<string, PendingQuantity>>;
  errors: Readonly<Record<string, string>>;
};
type Options = {
  read: () => Cart | undefined;
  write: (cart: Cart) => void;
  save: (id: string, quantity: number) => Promise<Cart>;
  refresh: () => Promise<Cart>;
  start: () => void;
  settled: (ids: string[]) => void;
};

// One queue per cart: responses contain the entire cart, so even writes to
// different products must stay ordered. Only the latest tapped quantity is sent.
export class CartQuantityQueue {
  private snapshot: Snapshot = { pending: {}, errors: {} };
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private active = true;
  private touched = new Set<string>();
  private uncertain = new Set<string>();

  constructor(private options: Options) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(pending = this.snapshot.pending, errors = this.snapshot.errors) {
    this.snapshot = { pending, errors };
    this.listeners.forEach(listener => listener());
  }

  change = (id: string, delta: number, available: number) => {
    const cart = this.options.read();
    if (!this.active || !cart) return;
    const intent = this.snapshot.pending[id];
    const current = intent?.quantity ?? cart.items.find(item => item.product_id === id)?.quantity ?? 0;
    const limit = intent?.limit ?? Math.min(1000000, Math.max(0, available));
    const quantity = current + delta;
    if (!Number.isInteger(quantity) || quantity < 0 || (delta > 0 && quantity > limit)) return;
    if (!Object.keys(this.snapshot.pending).length) this.options.start();
    const errors = { ...this.snapshot.errors };
    delete errors[id];
    this.publish({ ...this.snapshot.pending, [id]: { quantity, limit } }, errors);
    this.schedule();
  };

  private schedule() {
    clearTimeout(this.timer);
    if (this.active && !this.running) this.timer = setTimeout(() => void this.flush(), 180);
  }

  private async flush() {
    if (!this.active || this.running) return;
    this.running = true;
    try {
      while (this.active) {
        const entry = Object.entries(this.snapshot.pending)[0];
        if (!entry) break;
        const [id, intent] = entry;
        const confirmed = this.options.read()?.items.find(item => item.product_id === id)?.quantity ?? 0;
        let error: string | undefined;
        if (intent.quantity !== confirmed || this.uncertain.has(id)) {
          this.touched.add(id);
          try {
            const cart = await this.options.save(id, intent.quantity);
            if (!this.active) return;
            this.options.write(cart);
            this.uncertain.delete(id);
          } catch (cause) {
            if (!this.active) return;
            this.uncertain.add(id);
            // A lost response may have committed. Re-read before rolling back;
            // never retry an additive POST and accidentally add the item twice.
            try {
              const cart = await this.options.refresh();
              if (!this.active) return;
              this.options.write(cart);
              this.uncertain.delete(id);
            } catch { /* Keep the last confirmed cart; polling can recover. */ }
            if (!this.active) return;
            error = `Couldn't update this item. ${cause instanceof Error ? cause.message : 'Please try again.'}`;
          }
        }
        const pending = { ...this.snapshot.pending };
        const saved = this.options.read()?.items.find(item => item.product_id === id)?.quantity ?? 0;
        if (error || pending[id]?.quantity === intent.quantity || pending[id]?.quantity === saved) delete pending[id];
        this.publish(pending, error ? { ...this.snapshot.errors, [id]: error } : this.snapshot.errors);
      }
    } finally {
      this.running = false;
      if (this.active && !Object.keys(this.snapshot.pending).length && this.touched.size) {
        const ids = [...this.touched];
        this.touched.clear();
        this.options.settled(ids);
      }
    }
  }

  resume = () => {
    this.active = true;
    if (Object.keys(this.snapshot.pending).length) this.schedule();
  };

  dispose = () => {
    this.active = false;
    clearTimeout(this.timer);
  };
}

export function cartQuantityCount(cart: Cart | undefined, pending: Snapshot['pending']) {
  let count = cart?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0;
  for (const [id, intent] of Object.entries(pending)) {
    count += intent.quantity - (cart?.items.find(item => item.product_id === id)?.quantity ?? 0);
  }
  return count;
}
