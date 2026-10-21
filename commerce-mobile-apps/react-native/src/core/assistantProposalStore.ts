import { type CommerceClient } from './commerce';
import { isID, object, text, type Json } from './assistant';
import { FeatureState } from './featureState';
export type ProposalIssue = 'load' | 'unconfirmed' | 'apply' | null;
export class AssistantProposalStore extends FeatureState<{ proposal: Json; busy: boolean; pending: boolean; issue: ProposalIssue }> {
  constructor(readonly id: string, private client: Pick<CommerceClient, 'assistantProposal'>) { super({ proposal: null, busy: false, pending: false, issue: null }); }
  reset() { this.generation++; this.publish({ proposal: null, busy: false, pending: false, issue: null }); }
  get canApply() {
    const p = object(this.state.proposal), draft = object(p.draft), verdict = object(p.execution).verdict;
    return p.can_apply === true && p.applied !== true && Date.parse(text(p.expires_at)) > Date.now()
      && (verdict == null || verdict === 'pass') && (draft.mode !== 'buy_again' || isID(draft.location_id));
  }
  async reload(settled: () => Promise<void>) {
    if (this.state.busy) return;
    const revision = this.generation; this.publish({ ...this.state, busy: true, issue: null });
    try {
      const proposal = await this.client.assistantProposal(this.id); this.checkRevision(revision);
      const applied = object(proposal).applied === true;
      this.publish({ ...this.state, proposal, pending: applied ? false : this.state.pending, issue: !applied && this.state.pending ? 'unconfirmed' : null });
      if (applied) await settled();
    } catch { if (revision === this.generation) this.publish({ ...this.state, issue: 'load' }); }
    finally { if (revision === this.generation) this.publish({ ...this.state, busy: false }); }
  }
  async apply(operation: (id: string) => Promise<void>, settled: () => Promise<void>, locked: boolean) {
    if (this.state.busy || locked) return;
    if (this.state.pending) { await this.reload(settled); return; }
    if (!this.canApply) return;
    const revision = this.generation; this.publish({ ...this.state, busy: true, pending: true, issue: null });
    try { await operation(this.id); this.checkRevision(revision); }
    catch { if (revision === this.generation) this.publish({ ...this.state, issue: 'apply' }); }
    finally { if (revision === this.generation) this.publish({ ...this.state, busy: false }); }
    if (revision === this.generation) await this.reload(settled);
  }
}
