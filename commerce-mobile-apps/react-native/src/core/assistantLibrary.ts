import type { CommerceClient } from './commerce';
import { CommerceError } from './commerceError';
import { isID, validateBlock, type AssistantBlock } from './assistant';
import { FeatureState } from './featureState';

export interface HistoryTurn { conversation_id:string;request_id:string;question:string;answer:string;created_at:string;blocks?:AssistantBlock[] }
export function parseHistory(value:unknown):HistoryTurn[] {
  if(!Array.isArray(value)||value.length>100)throw new CommerceError(502,'History unavailable');
  for(const turn of value){if(!turn||!isID(turn.conversation_id)||!isID(turn.request_id)||typeof turn.question!=='string'||typeof turn.answer!=='string'||turn.question.length>16000||turn.answer.length>65536||typeof turn.created_at!=='string'||!Number.isFinite(Date.parse(turn.created_at))||turn.blocks!=null&&(!Array.isArray(turn.blocks)||turn.blocks.length>32))throw new CommerceError(502,'History unavailable');for(const block of turn.blocks??[])validateBlock(block);}
  if(new Set(value.map(t=>t.request_id)).size!==value.length)throw new CommerceError(502,'History unavailable');return value;
}
export const preferenceAttributes=['product','brand','color','style','metal','material'] as const;
export const memoryOccasions=['any','everyday','gift','work','travel'] as const;
export interface PreferenceInput {attribute:string;value:string;category_id:string;occasion:string;recipient:string;goal_id:string|null;dislike:boolean;replaces:string|null}
export const emptyPreference=():PreferenceInput=>({attribute:'product',value:'',category_id:'',occasion:'any',recipient:'self',goal_id:null,dislike:false,replaces:null});
export interface MemoryPreference {id:string;attribute:string;value:string;category_id:string;occasion:string;recipient:string;goal_id:string|null;signal:string}
export interface MemoryView {enabled:boolean;guest:boolean;personalized:boolean;journey_consent:boolean;consent_version:number;expires_at:string|null;preferences:MemoryPreference[];signals:{product_id:string;name:string;kind:string}[];categories:{id:string;name:string}[];products:{id:string;name:string;category_id:string}[]}
export interface SavedGoal {task_id:string;name:string;archived:boolean;version:number;state:string|null;expires_at:string}
export type MemoryAction={kind:'consent';personalized:boolean;journey:boolean;version:number}|{kind:'preference';input:PreferenceInput}|{kind:'removePreference';id:string}|{kind:'clearContext';id:string}|{kind:'delete'}|{kind:'goal';goal:SavedGoal;name:string;archived:boolean}|{kind:'deleteGoal';goal:SavedGoal};
export function validPreference(input:PreferenceInput,view:MemoryView|null){return !!view?.personalized&&preferenceAttributes.some(v=>v===input.attribute)&&memoryOccasions.some(v=>v===input.occasion)&&['self','other'].includes(input.recipient)&&view.categories.some(c=>c.id===input.category_id)&&!!input.value.trim()&&[...input.value].length<=100&&(input.attribute!=='product'||view.products.some(p=>p.id===input.value&&p.category_id===input.category_id)||!!input.replaces&&view.preferences.some(p=>p.id===input.replaces&&p.value===input.value&&p.category_id===input.category_id));}
interface State {history:HistoryTurn[];memory:MemoryView|null;goals:SavedGoal[];draft:PreferenceInput;busy:boolean;failed:boolean;loaded:boolean;needsRefresh:boolean;exported:string|null;changed:boolean}
const initial=():State=>({history:[],memory:null,goals:[],draft:emptyPreference(),busy:false,failed:false,loaded:false,needsRefresh:false,exported:null,changed:false});
type Client=Pick<CommerceClient,'assistantHistory'|'memoryView'|'savedGoals'|'changeMemory'|'exportMemory'>;
export class AssistantLibrary extends FeatureState<State> {
  constructor(private client:Client){super(initial());}
  reset(){this.generation++;this.publish(initial());}
  edit(draft:PreferenceInput){if(!this.state.busy&&!this.state.needsRefresh)this.publish({...this.state,draft});}
  editPreference(p:MemoryPreference){this.edit({...p,dislike:p.signal==='explicit_dislike',replaces:p.id});}
  conversations(search=''){const groups=new Map<string,{id:string;title:string;created:string;updated:string;matches:boolean}>();const needle=search.trim().toLocaleLowerCase();for(const turn of this.state.history){const matches=`${turn.question} ${turn.answer}`.toLocaleLowerCase().includes(needle),old=groups.get(turn.conversation_id);if(!old)groups.set(turn.conversation_id,{id:turn.conversation_id,title:turn.question,created:turn.created_at,updated:turn.created_at,matches});else{if(turn.created_at<old.created){old.title=turn.question;old.created=turn.created_at;}if(turn.created_at>old.updated)old.updated=turn.created_at;old.matches ||= matches;}}return [...groups.values()].filter(g=>g.matches).sort((a,b)=>b.updated.localeCompare(a.updated));}
  private async work(operation:(check:()=>void)=>Promise<void>){if(this.state.busy)return;const revision=this.generation;this.publish({...this.state,busy:true,failed:false});try{await operation(()=>this.checkRevision(revision));}catch(e){if(revision===this.generation)this.publish({...this.state,failed:true});throw e;}finally{if(revision===this.generation)this.publish({...this.state,busy:false});}}
  async refresh(conversation:string,signedIn:boolean){await this.work(async check=>{
    let failure:unknown,memory:MemoryView|null=null;
    try{memory=await this.client.memoryView(conversation);check();this.publish({...this.state,memory,exported:null});}catch(e){check();failure=e;this.publish({...this.state,memory:null,exported:null});}
    try{const history=signedIn?await this.client.assistantHistory():[];check();this.publish({...this.state,history,loaded:true});}catch(e){check();failure??=e;}
    try{const goals=signedIn?await this.client.savedGoals():[];check();this.publish({...this.state,goals});}catch(e){check();failure??=e;}
    if(failure)throw failure;if(memory)this.publish({...this.state,needsRefresh:false});
  });}
  async open(id:string,accept:(turns:HistoryTurn[])=>void){await this.work(async check=>{const turns=(await this.client.assistantHistory(id)).filter(t=>t.conversation_id.toLowerCase()===id.toLowerCase()).sort((a,b)=>a.created_at.localeCompare(b.created_at));check();if(!turns.length)throw new CommerceError(404,'This conversation is no longer available');accept(turns);});}
  async resumeGoal(id:string,accept:(turns:HistoryTurn[])=>void){await this.work(async check=>{const goals=await this.client.savedGoals();check();this.publish({...this.state,goals});if(!goals.some(g=>g.task_id===id&&!g.archived&&Date.parse(g.expires_at)>Date.now()))throw new CommerceError(409,'This saved goal is no longer active');const turns=(await this.client.assistantHistory(id)).filter(t=>t.conversation_id===id).sort((a,b)=>a.created_at.localeCompare(b.created_at));check();accept(turns);});}
  async mutate(action:MemoryAction,conversation:string,signedIn:boolean){if(this.state.needsRefresh||!this.state.memory)throw new CommerceError(409,'Refresh memory before making changes');if(action.kind==='preference'&&!validPreference(action.input,this.state.memory))throw new CommerceError(422,'Complete a valid preference');await this.work(async check=>{this.publish({...this.state,needsRefresh:true,exported:null,changed:false});await this.client.changeMemory(action);check();this.publish({...this.state,changed:true,draft:action.kind==='preference'||action.kind==='delete'?emptyPreference():this.state.draft});});await this.refresh(conversation,signedIn);}
  async export(){await this.work(async check=>{const value=await this.client.exportMemory();check();this.publish({...this.state,exported:JSON.stringify(value,null,2)});});}
  clearExport(){this.publish({...this.state,exported:null});}
}
