import { FeatureState, OperationCancelled } from './featureState';

export type OperationKind = 'initial' | 'refresh' | 'mutation';
export interface OperationLoadingState { active: boolean; queued: number; kind: OperationKind | null; busy: boolean }

export function loadingLabel(state: OperationLoadingState, locale: string) {
  return state.kind === 'initial' ? (locale === 'ar' ? 'جارٍ التحميل' : 'Loading')
    : state.kind === 'refresh' ? (locale === 'ar' ? 'جارٍ التحديث' : 'Refreshing')
    : state.kind === 'mutation' ? (locale === 'ar' ? 'جارٍ حفظ التغييرات' : 'Updating')
    : locale === 'ar' ? 'في الانتظار' : 'Waiting';
}

/** FIFO commerce queue. An operation must not await another run on the same queue. */
export class OperationCoordinator extends FeatureState<OperationLoadingState> {
  private tail: Promise<void> = Promise.resolve();
  private count = 0;
  private activeKind: OperationKind | null = null;
  constructor() { super({ active: false, queued: 0, kind: null, busy: false }); }
  private changed() { this.publish({ active: this.activeKind !== null, queued: Math.max(0, this.count - (this.activeKind ? 1 : 0)), kind: this.activeKind, busy: this.count > 0 }); }
  get busy() { return this.state.busy; }
  invalidatePending() { this.generation++; }
  async run<T>(operation: () => Promise<T>, signal?: AbortSignal, kind: OperationKind = 'mutation'): Promise<T> {
    const revision = this.generation;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    this.count++; this.changed();
    try {
      await previous;
      this.checkRevision(revision);
      if (signal?.aborted) throw new OperationCancelled();
      this.activeKind = kind; this.changed();
      try { return await operation(); } finally { this.activeKind = null; this.changed(); }
    } finally { this.count--; this.changed(); release(); }
  }
}
