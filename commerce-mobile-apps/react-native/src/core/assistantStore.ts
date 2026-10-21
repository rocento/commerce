import { CommerceError, type CommerceClient } from './commerce';
import { consume, emptyReply, followupProduct, type AssistantReply } from './assistant';
import { FeatureState } from './featureState';
import type { HistoryTurn } from './assistantLibrary';
export type AssistantTurn = Readonly<{ id: string; question: string; reply: AssistantReply; interrupted: boolean }>;
export type AssistantState = Readonly<{ turns: AssistantTurn[]; draft: string; busy: boolean; stage: string; signIn: boolean }>;
const initial = (): AssistantState => ({ turns: [], draft: '', busy: false, stage: 'preparing', signIn: false });
type AssistantClient = Pick<CommerceClient, 'assistantID' | 'streamAssistant'>;
export class AssistantStore extends FeatureState<AssistantState> {
  private conversation: string;
  getBusySnapshot = () => this.state.busy;
  private cancelPending?: () => void;
  personalize = true;
  get conversationID(){return this.conversation;}
  setPersonalize(value:boolean){if(!this.state.busy){this.personalize=value;this.publish({...this.state});}}
  restoreConversation(id:string,history:HistoryTurn[]){if(this.state.busy)throw new CommerceError(409,'Wait for the current response');this.generation++;this.conversation=id;this.publish({...initial(),turns:history.map(t=>({id:t.request_id,question:t.question,reply:{...emptyReply(),text:t.answer,blocks:t.blocks??[],completed:true},interrupted:false}))});}
  private controller?: AbortController;
  constructor(private client: AssistantClient) { super(initial()); this.conversation = client.assistantID(); }
  setDraft(draft: string) { this.publish({ ...this.state, draft }); }
  reset() { this.generation++; this.cancelPending?.(); this.cancelPending = undefined; this.controller?.abort(); this.controller = undefined; this.conversation = this.client.assistantID(); this.personalize=true; this.publish(initial()); }
  stop() { this.controller?.abort(); }
  async send(value: string, options: { product?: string; cart?: boolean; locked?: boolean; settled: () => Promise<void>; checkout: () => void }) {
    const message = value.trim();
    if (this.state.busy || options.locked || !message || [...message].length > 4000) return;
    const abort = new AbortController(), revision = this.generation, id = this.client.assistantID();
    const previous = this.state.turns.at(-1)?.reply;
    this.controller = abort;
    let reply = emptyReply();
    this.publish({ ...this.state, turns: [...this.state.turns.slice(-49), { id, question: message, reply, interrupted: false }], draft: '', busy: true, stage: 'preparing', signIn: false });
    const turn = (interrupted = false) => this.state.turns.map(value => value.id === id ? { ...value, reply, interrupted } : value);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stage = this.state.stage;
    const cancel = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
    const flush = () => {
      cancel();
      if (revision === this.generation) this.publish({ ...this.state, turns: turn(), stage });
    };
    this.cancelPending = cancel;
    try {
      await this.client.streamAssistant({ request_id: id, conversation_id: this.conversation, message, personalize:this.personalize,
        product_id: options.product ?? (options.cart ? undefined : followupProduct(previous, message)), cart_context: options.cart || undefined, clarification: previous?.clarification }, event => {
        if (revision !== this.generation || abort.signal.aborted) return;
        reply = consume(reply, event);
        stage = event.type === 'progress' ? event.stage ?? 'preparing' : event.type === 'message.delta' ? 'responding' : stage;
        // Consume every delta, but coalesce text paints. Structured actions and completion
        // are published immediately and never delayed behind the rendering timer.
        if (event.type === 'message.delta') { timer ??= setTimeout(flush, 32); }
        else flush();
      }, abort.signal);
      flush();
      if (abort.signal.aborted && revision === this.generation) { reply = { ...reply, failed: true }; this.publish({ ...this.state, turns: turn(true) }); }
    } catch (error) {
      if (revision !== this.generation) return;
      reply = { ...reply, failed: true };
      this.publish({ ...this.state, turns: turn(true), signIn: error instanceof CommerceError && error.status === 401 });
    } finally {
      cancel();
      if (revision === this.generation) {
        this.cancelPending = undefined;
        // An interrupted stream may already have changed the bag. Never replay it.
        try { await options.settled(); } catch { /* The parent exposes refresh errors. */ }
        if (revision === this.generation) {
          this.controller = undefined; this.publish({ ...this.state, busy: false });
          if (!abort.signal.aborted && reply.completed && !reply.failed && reply.checkoutRequested) options.checkout();
        }
      }
    }
  }
}
