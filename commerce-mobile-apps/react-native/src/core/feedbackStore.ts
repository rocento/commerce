import { CommerceError } from './commerce';
import { FeatureState, OperationCancelled } from './featureState';
import { OperationCoordinator, type OperationKind } from './operations';
export type FailureKind = 'validation' | 'authentication' | 'permission' | 'conflict' | 'rateLimit' | 'server' | 'connection' | 'unknown';
export interface AppFailure { kind: FailureKind; message: string; status?: number }
export function mapFailure(error: unknown, locale = 'en'): AppFailure | null {
  if (error instanceof OperationCancelled || (error instanceof Error && error.name === 'AbortError')) return null;
  const fallback = locale === 'ar' ? 'تعذر الاتصال. تحقق من اتصالك وحاول مرة أخرى.' : 'Unable to connect. Check your connection and retry.';
  if (error instanceof CommerceError) {
    const status = error.status;
    const kind: FailureKind = status === 400 || status === 422 ? 'validation' : status === 401 ? 'authentication' : status === 403 ? 'permission' : status === 409 ? 'conflict' : status === 429 ? 'rateLimit' : status >= 500 && status <= 599 ? 'server' : 'unknown';
    return { kind, message: error.message || fallback, status };
  }
  return { kind: error instanceof TypeError ? 'connection' : 'unknown', message: fallback };
}
export interface FeedbackState { failure: AppFailure | null; notice: string | null }
/** Holds display-safe messages, never raw exceptions or automatic retry actions. */
export class FeedbackStore extends FeatureState<FeedbackState> {
  constructor() { super({ failure: null, notice: null }); }
  setError(message: string | null) { this.publish({ ...this.state, failure: message ? { kind: 'unknown', message } : null }); }
  setNotice(notice: string | null) { this.publish({ ...this.state, notice: notice || null }); }
  clear() { this.publish({ failure: null, notice: null }); }
  async perform(queue: OperationCoordinator, operation: () => Promise<void>, options: { kind?: OperationKind; locale?: string; onUnauthorized?: () => void } = {}): Promise<boolean> {
    try {
      return await queue.run(async () => {
        this.clear();
        try { await operation(); return true; }
        catch (error) {
          const failure = mapFailure(error, options.locale);
          if (!failure) throw error;
          const notice = this.state.notice;
          if (failure.kind === 'authentication') options.onUnauthorized?.();
          this.publish({ failure, notice }); return false;
        }
      }, undefined, options.kind);
    } catch (error) {
      const failure = mapFailure(error, options.locale);
      if (failure) this.publish({ ...this.state, failure });
      return false;
    }
  }
}
