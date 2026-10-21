import type { CommerceClient } from './commerce';
import { CommerceError } from './commerceError';
import { FeatureState } from './featureState';

export interface ReviewInput { display_name: string; rating: number; title: string; body: string }
export interface Review extends ReviewInput { id: string; status?: string; version?: number; moderation_reason?: string | null; created_at: string }
export const emptyReview = (): ReviewInput => ({ display_name: '', rating: 5, title: '', body: '' });
export const validReview = (draft: ReviewInput) => Number.isInteger(draft.rating) && draft.rating >= 1 && draft.rating <= 5 && (['display_name', 'title', 'body'] as const).every((key, i) => !!draft[key].trim() && new TextEncoder().encode(draft[key]).length <= [80, 200, 4000][i]!);
type Client = Pick<CommerceClient, 'reviews' | 'ownReview' | 'submitReview'>;
export class ReviewsStore extends FeatureState<{ product: string; reviews: Review[]; own: Review | null; draft: ReviewInput; offset: number; busy: boolean; loaded: boolean; ownLoaded: boolean; failed: boolean; dirty: boolean; uncertain: boolean; submitted: boolean }> {
  constructor(private client: Client) { super({ product: '', reviews: [], own: null, draft: emptyReview(), offset: 0, busy: false, loaded: false, ownLoaded: false, failed: false, dirty: false, uncertain: false, submitted: false }); }
  reset() { this.generation++; this.publish({ product: '', reviews: [], own: null, draft: emptyReview(), offset: 0, busy: false, loaded: false, ownLoaded: false, failed: false, dirty: false, uncertain: false, submitted: false }); }
  edit(draft: ReviewInput) { if (!this.state.busy && !this.state.uncertain) this.publish({ ...this.state, draft, dirty: true, submitted: false }); }
  async open(product: string, signedIn: boolean) { this.reset(); this.publish({ ...this.state, product }); await this.load(signedIn, 0); }
  async load(signedIn: boolean, offset = this.state.offset) {
    if (this.state.busy) return;
    const revision = this.generation, product = this.state.product;
    this.publish({ ...this.state, busy: true, failed: false });
    try {
      const reviews = await this.client.reviews(product, offset); this.checkRevision(revision);
      this.publish({ ...this.state, reviews, offset, loaded: true });
      const own = signedIn ? await this.client.ownReview(product) : null; this.checkRevision(revision);
      this.publish({ ...this.state, own, ownLoaded: true, draft: !this.state.dirty ? own ?? emptyReview() : this.state.draft, uncertain: false });
    } catch (error) { if (revision === this.generation) this.publish({ ...this.state, failed: true }); throw error; }
    finally { if (revision === this.generation) this.publish({ ...this.state, busy: false }); }
  }
  async submit(verified: boolean) {
    if (this.state.busy || !this.state.ownLoaded || this.state.uncertain || !verified || !validReview(this.state.draft)) throw new CommerceError(422, 'Verify your account and complete a valid review');
    const revision = this.generation, draft = this.state.draft;
    this.publish({ ...this.state, busy: true, submitted: false, uncertain: true });
    try {
      const own = await this.client.submitReview(this.state.product, draft); this.checkRevision(revision);
      this.publish({ ...this.state, own, draft: own, dirty: false, submitted: true, uncertain: false, reviews: this.state.reviews.filter(r => r.id !== own.id) });
      try {
        const reviews = await this.client.reviews(this.state.product, this.state.offset); this.checkRevision(revision);
        this.publish({ ...this.state, reviews, failed: false });
      } catch { if (revision === this.generation) this.publish({ ...this.state, failed: true }); }
    } finally { if (revision === this.generation) this.publish({ ...this.state, busy: false }); }
  }
}
