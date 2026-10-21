import type { CommerceClient } from './commerce';
import { CommerceError } from './commerceError';
import { FeatureState } from './featureState';

export const supportCategories = ['order_issue', 'product_question', 'complaint', 'payment_dispute', 'other'] as const;
export interface SupportDraft { subject: string; category: string; body: string; order_id?: string; contact_name?: string; contact?: string }
export interface SupportInput extends SupportDraft { request_id: string }
export interface SupportTicket { id: string; number: number; subject: string; category: string; status: string; priority: string; order_id?: string | null; created_at: string }
export interface SupportDetail { ticket: SupportTicket; messages: { id: string; sender: string; body: string; created_at: string }[] }
export const supportTextValid = (value: string, max: number) => !!value.trim() && new TextEncoder().encode(value).length <= max;
export const validSupport = (draft: SupportDraft, signedIn: boolean) => supportTextValid(draft.subject,160) && supportTextValid(draft.body,2000) && supportCategories.some(c=>c===draft.category) && (signedIn || (!draft.order_id && supportTextValid(draft.contact_name??'',100) && supportTextValid(draft.contact??'',254)));
const empty = ():SupportDraft => ({subject:'',category:'other',body:''});
interface State { draft:SupportDraft; attempt:SupportInput|null; reply:string; replyAttempt:{id:string;request_id:string;body:string}|null; tickets:SupportTicket[]; detail:SupportDetail|null; selected:string|null; busy:boolean; loaded:boolean; failed:boolean; created:boolean; replied:boolean; composing:boolean }
const initial=():State=>({draft:empty(),attempt:null,reply:'',replyAttempt:null,tickets:[],detail:null,selected:null,busy:false,loaded:false,failed:false,created:false,replied:false,composing:false});
type Client=Pick<CommerceClient,'supportTickets'|'supportDetail'|'createSupport'|'replySupport'>;
export class SupportStore extends FeatureState<State> {
  private replies=new Map<string,string>();
  constructor(private client:Client,private randomID:()=>string){super(initial());}
  reset(){this.generation++;this.replies.clear();this.publish(initial());}
  edit(draft:SupportDraft){if(!this.state.busy&&!this.state.attempt)this.publish({...this.state,draft});}
  editReply(reply:string){if(!this.state.busy&&!this.state.replyAttempt){this.replies.set(this.state.selected??'',reply);this.publish({...this.state,reply,replied:false});}}
  compose(order?:string){if(this.state.busy)return;this.publish({...this.state,composing:true,created:false,draft:this.state.attempt?this.state.draft:{...this.state.draft,order_id:order??this.state.draft.order_id}});}
  showList(){if(!this.state.busy)this.publish({...this.state,composing:false,selected:null,detail:null});}
  private async work(operation:(check:()=>void)=>Promise<void>){if(this.state.busy)return;const revision=this.generation;this.publish({...this.state,busy:true,failed:false});try{await operation(()=>this.checkRevision(revision));}catch(error){if(revision===this.generation)this.publish({...this.state,failed:true});throw error;}finally{if(revision===this.generation)this.publish({...this.state,busy:false});}}
  async refresh(){await this.work(async check=>{const tickets=await this.client.supportTickets();check();this.publish({...this.state,tickets,loaded:true});});}
  async open(id:string){await this.work(async check=>{this.publish({...this.state,selected:id,detail:null,composing:false,reply:this.replies.get(id)??'',created:false,replied:false});const detail=await this.client.supportDetail(id);check();this.publish({...this.state,detail});});}
  async create(signedIn:boolean){await this.work(async check=>{
    if(!this.state.attempt&&!validSupport(this.state.draft,signedIn))throw new CommerceError(422,'Complete the support form');
    const attempt=this.state.attempt??{...this.state.draft,request_id:this.randomID()};this.publish({...this.state,attempt});
    try{const detail=await this.client.createSupport(attempt);check();this.publish({...this.state,detail,selected:detail.ticket.id,created:true,composing:false,attempt:null,draft:empty(),reply:'',tickets:[detail.ticket,...this.state.tickets.filter(t=>t.id!==detail.ticket.id)]});}
    catch(error){check();if(error instanceof CommerceError&&[400,422].includes(error.status))this.publish({...this.state,attempt:null});throw error;}
  });}
  async sendReply(){await this.work(async check=>{
    const id=this.state.selected;
    if(!id||!this.state.detail||this.state.replyAttempt&&this.state.replyAttempt.id!==id)throw new CommerceError(409,'Return to the pending reply before sending another');
    if(!this.state.replyAttempt&&!supportTextValid(this.state.reply,2000))throw new CommerceError(422,'Enter a message within 2000 bytes');
    const attempt=this.state.replyAttempt??{id,request_id:this.randomID(),body:this.state.reply};this.publish({...this.state,replyAttempt:attempt});
    try{const detail=await this.client.replySupport(id,attempt.request_id,attempt.body);check();this.replies.delete(id);this.publish({...this.state,detail,reply:'',replyAttempt:null,replied:true});}
    catch(error){check();if(error instanceof CommerceError&&[400,422].includes(error.status))this.publish({...this.state,replyAttempt:null});throw error;}
  });}
}
