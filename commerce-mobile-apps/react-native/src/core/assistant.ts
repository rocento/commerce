// The same bounded SSE contract consumed by the native iOS shopping assistant.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const text = (value: unknown) => typeof value === 'string' ? value : '';
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const isID = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
export interface Clarification { original_message: string; question: string; revision?: string; kind?: string; choices?: string[]; optional?: boolean }
export interface AssistantInput { request_id: string; conversation_id: string; message: string; product_id?: string; cart_context?: boolean; clarification?: Clarification; personalize?:boolean }
export interface AssistantProduct { id: string; name: string; price: string; currency: string; original_price?: string; image_id?: string; in_stock?: boolean; route: string; reasons: string[]; unmet: string[]; attributes: { name: string; value: string }[] }
export interface AssistantBlock {
  kind: string; title?: string; text?: string; products?: AssistantProduct[];
  sources?: { kind: string; product_id: string; route: string }[];
  rows?: { label: string; values: string[] }[];
  action?: Json; cart?: Json; proposal_id?: string; product_prompt?: Json;
  cart_removal?: Json; cart_removal_choice?: Json; compound_choice?: Json;
}
export interface AssistantEvent { version: string; request_id: string; sequence: number; type: string; text?: string; code?: string; stage?: string; response_source?: string; blocks?: AssistantBlock[]; clarification?: Clarification; saved?: boolean; failure?: Json; order?: Json; ticket?: Json }
const invalid = () => new Error('Invalid assistant response');
export function validateBlock(block: AssistantBlock) {
  if (!['text', 'product_card', 'product_list', 'comparison_table', 'recommendation_group', 'action', 'cart_summary', 'basket_proposal', 'saved_addresses', 'wishlist_manage', 'wishlist_transfer', 'product_prompt', 'cart_removal', 'cart_removal_choice', 'compound_choice'].includes(block.kind)) throw invalid();
  if (block.products) {
    const p = block.products, sources = block.sources;
    if (!Array.isArray(p) || p.length < 1 || p.length > 8 || new Set(p.map(v => v.id)).size !== p.length || !Array.isArray(sources) || sources.length !== p.length) throw invalid();
    p.forEach((v, i) => {
      if (!isID(v.id) || v.route !== `/products/${v.id}` || sources[i]?.kind !== 'catalog' || sources[i]?.product_id !== v.id || sources[i]?.route !== v.route || !text(v.name) || v.name.length > 1000 || typeof v.price !== 'string' || typeof v.currency !== 'string' || (v.image_id != null && !isID(v.image_id))) throw invalid();
      if (![v.reasons, v.unmet, v.attributes].every(a => Array.isArray(a) && a.length <= 20) || !v.reasons.every(s => typeof s === 'string') || !v.unmet.every(s => typeof s === 'string') || !v.attributes.every(a => typeof a.name === 'string' && typeof a.value === 'string')) throw invalid();
    });
  }
  if (['product_card', 'product_list', 'comparison_table', 'recommendation_group'].includes(block.kind) && !block.products) throw invalid();
  if (block.kind === 'product_card' && block.products?.length !== 1) throw invalid();
  if (block.kind === 'comparison_table' && ((block.products?.length ?? 0) < 2 || !Array.isArray(block.rows) || !block.rows.length || block.rows.length > 24 || !block.rows.every(row => typeof row.label === 'string' && Array.isArray(row.values) && row.values.length === block.products?.length && row.values.every(v => typeof v === 'string')))) throw invalid();
  if (block.kind === 'basket_proposal' && !isID(block.proposal_id)) throw invalid();
  if (block.kind === 'action' && object(block.action).route !== '/search') throw invalid();
  if (block.kind === 'cart_summary' && !block.cart) throw invalid();
}
export class AssistantDecoder {
  private buffer = ''; private data: string[] = []; private bytes = 0; private sequence = 0; private rich = false;
  private utf8 = new TextDecoder('utf-8', { fatal: true });
  done = false;
  constructor(private requestID: string) {}
  feed(chunk: Uint8Array): AssistantEvent[] {
    this.bytes += chunk.byteLength;
    if (this.bytes > 65536) throw invalid();
    this.buffer += this.utf8.decode(chunk, { stream: true });
    const events: AssistantEvent[] = [];
    let end: number;
    while (!this.done && (end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, ''); this.buffer = this.buffer.slice(end + 1);
      if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
      else if (!line && this.data.length) {
        const payload = this.data.join('\n'); this.data = [];
        const event = JSON.parse(payload) as AssistantEvent;
        if (event.version !== '1' || typeof event.request_id !== 'string' || event.request_id.toLowerCase() !== this.requestID.toLowerCase() || event.sequence !== this.sequence || !['progress', 'message.delta', 'content.blocks', 'card.order', 'ticket.created', 'error', 'done'].includes(event.type)) throw invalid();
        if (['message.delta', 'error'].includes(event.type) && (!text(event.text) || event.text!.length > 8000)) throw invalid();
        if (event.code === 'open_checkout' && (event.type !== 'message.delta' || !['R', 'L'].includes(event.response_source ?? '') || [event.blocks, event.order, event.ticket, event.failure, event.clarification, event.stage, event.saved].some(v => v != null))) throw invalid();
        if (event.type === 'progress' && !['preparing', 'catalog', 'order', 'support', 'responding'].includes(event.stage ?? '')) throw invalid();
        if (event.clarification) {
          const c = event.clarification;
          if (event.type !== 'message.delta' || typeof c.original_message !== 'string' || c.original_message.length > 4000 || typeof c.question !== 'string' || c.question.length > 1000 || (c.choices != null && (!Array.isArray(c.choices) || c.choices.length > 8 || !c.choices.every(v => typeof v === 'string'))) || (c.kind === 'shopping' && !isID(c.revision))) throw invalid();
        }
        if (event.type === 'content.blocks') {
          if (this.rich || !Array.isArray(event.blocks) || !event.blocks.length || event.blocks.length > 8 || new TextEncoder().encode(payload).length > 24576 || event.text != null || event.code != null) throw invalid();
          event.blocks.forEach(validateBlock); this.rich = true;
        } else if (event.blocks != null) throw invalid();
        if ((event.type === 'card.order' && !event.order) || (event.type === 'ticket.created' && !event.ticket) || (event.failure && text(object(event.failure).request_reference).toLowerCase() !== this.requestID.toLowerCase()) || (event.saved != null && event.type !== 'done')) throw invalid();
        this.sequence++; this.done = event.type === 'done'; events.push(event);
      }
    }
    return events;
  }
  finish() { this.utf8.decode(); if (!this.done) throw new Error('Assistant response interrupted'); }
}
export interface AssistantReply { text: string; blocks: AssistantBlock[]; clarification?: Clarification; completed: boolean; failed: boolean; needsLogin: boolean; needsAddress: boolean; checkoutRequested: boolean; order?: Json; ticket?: Json }
export const emptyReply = (): AssistantReply => ({ text: '', blocks: [], completed: false, failed: false, needsLogin: false, needsAddress: false, checkoutRequested: false });
export function consume(reply: AssistantReply, event: AssistantEvent): AssistantReply {
  const r = { ...reply };
  if (event.type === 'message.delta' || event.type === 'error') {
    r.text = (r.text + (event.type === 'error' && r.text ? '\n' : '') + event.text).slice(0, 8000);
    r.needsLogin ||= event.code === 'login_required' || object(event.failure).recovery === 'sign_in';
    r.needsAddress ||= ['area_unavailable', 'open_address_form'].includes(event.code ?? '');
    r.checkoutRequested ||= event.code === 'open_checkout';
    r.clarification = event.clarification ?? r.clarification;
    r.failed ||= event.type === 'error';
  }
  if (event.type === 'content.blocks') r.blocks = event.blocks!;
  if (event.type === 'card.order') r.order = event.order;
  if (event.type === 'ticket.created') r.ticket = event.ticket;
  if (event.type === 'done') r.completed = true;
  return r;
}
export function followupProduct(reply: AssistantReply | undefined, message: string) {
  if (!reply || reply.order || reply.blocks.some(b => ['cart_summary', 'cart_removal'].includes(b.kind))) return undefined;
  const ids = [...new Set(reply.blocks.flatMap(b => b.products?.map(p => p.id) ?? []))];
  return ids.length === 1 && /^(?:(?:please )?(?:price|availability|stock|details|how much is it|is it available|is it in stock|tell me about it|add(?: \d+)?(?: of)? (?:it|this|that)(?: to (?:my |the )?cart)?|remove (?:it|this|that)(?: from (?:my |the )?cart)?)|(?:أضفه|اضفه|أضف هذا|اضف هذا)(?: إلى السلة| للسلة)?|كم سعره|هل هو متوفر|احذفه من السلة)$/i.test(message.normalize('NFKC').trim().replace(/[.!?؟]+$/, '')) ? ids[0] : undefined;
}
