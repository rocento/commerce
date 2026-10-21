/** Framework-independent observable state; React consumes stable snapshots. */
export class FeatureState<T> {
  private listeners = new Set<() => void>();
  protected generation = 0;
  constructor(protected state: T) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  protected publish(state: T) { this.state = state; this.listeners.forEach(listener => listener()); }
  protected checkRevision(revision: number) { if (revision !== this.generation) throw new OperationCancelled(); }
}
export class OperationCancelled extends Error { constructor() { super('Operation belongs to a previous session'); } }
