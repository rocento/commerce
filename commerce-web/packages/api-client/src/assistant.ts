import { validates, parseAssistantFailure } from "./assistant-validation";
import { deliveryHeaders } from "./delivery";
import type { components } from "./schema";
import { assistantHeaders, ApiError } from "./identity";
import { assistantSchemas } from "./assistant-schemas";
export type AssistantEvent = components["schemas"]["AssistantEvent"];
export type AssistantBlock = components["schemas"]["AssistantBlock"];
export type AssistantInput = components["schemas"]["AssistantChatInput"];
export function parseAssistantEvent(data: string, requestId: string, sequence: number): AssistantEvent {
  const value: unknown = JSON.parse(data);
  if (!validates(value, assistantSchemas.AssistantEvent)) throw new Error("Invalid assistant event");
  const event = value as AssistantEvent;
  if (event.code === "open_checkout" && (event.type !== "message.delta" || !event.response_source || event.order || event.ticket || event.blocks || event.stage || event.clarification || event.failure || event.saved !== undefined)) throw new Error("Invalid checkout command");
  if (event.code === "clear_comparison" && (event.type !== "message.delta" || event.response_source !== "R" || event.order || event.ticket || event.blocks || event.stage || event.clarification || event.saved !== undefined)) throw new Error("Invalid comparison command");
  if (event.request_id !== requestId || event.sequence !== sequence || (event.type === "progress" && (!event.stage || event.text || event.order || event.ticket)) || (event.type === "card.order" && !event.order) || (event.type === "ticket.created" && !event.ticket) || ((event.type === "message.delta" || event.type === "error") && !event.text)) throw new Error("Invalid assistant stream");
  if (event.clarification && event.type !== "message.delta") throw new Error("Unexpected clarification");
  if (event.clarification?.kind === "shopping" && (!event.clarification.revision || !event.clarification.choices || new Set(event.clarification.choices).size !== event.clarification.choices.length)) throw new Error("Invalid shopping clarification");
  if (event.failure && (event.type !== "error" || event.failure.request_reference !== requestId)) throw new Error("Invalid failure reference");
  if (event.saved !== undefined && event.type !== "done") throw new Error("Unexpected persistence flag");
  if (event.type === "content.blocks") {
    if (!event.blocks || event.text || event.order || event.ticket || event.stage || event.code) throw new Error("Invalid rich event");
    for (const block of event.blocks) validateBlock(block);
  } else if (event.blocks) throw new Error("Unexpected rich content");
  return event;
}
function validateBlock(block: AssistantBlock): void {
  const fields = Object.keys(block).filter(k => k !== "kind").sort().join(",");
  if (block.kind === "cart_removal") {
    if (fields !== "cart_removal" || !block.cart_removal) throw new Error("Invalid removal receipt");
    if (block.cart_removal.remaining_quantity > block.cart_removal.cart_quantity) throw new Error("Invalid removal quantities");
    return;
  }
  if (block.kind === "cart_removal_choice") {
    if (fields !== "cart_removal_choice" || !block.cart_removal_choice) throw new Error("Invalid removal choice");
    const ids = block.cart_removal_choice.items.map(item => item.product_id);
    if (new Set(ids).size !== ids.length) throw new Error("Repeated removal choice");
    return;
  }
  if (block.kind === "product_prompt") { if (fields !== "product_prompt" || !block.product_prompt) throw new Error("Invalid product prompt"); return; }
  if (block.kind === "text") { if (fields !== "text") throw new Error("Invalid text block"); return; }
  if (block.kind === "action") { if (fields !== "action") throw new Error("Invalid action block"); return; }
  if (block.kind === "saved_addresses") { if (fields !== "") throw new Error("Invalid saved addresses block"); return; }
  if (block.kind === "basket_proposal") { if (fields !== "proposal_id" || !block.proposal_id) throw new Error("Invalid proposal reference"); return; }
  if (block.kind === "cart_summary") {
    if (fields !== "cart" || !block.cart) throw new Error("Invalid cart block");
    const { items, total_lines, total_quantity } = block.cart;
    const quantity = items.reduce((sum, item) => sum + item.quantity, 0);
    if (new Set(items.map(item => item.product_id)).size !== items.length || total_lines < items.length || total_quantity < quantity || (total_lines > 0 && items.length === 0) || (total_lines === items.length && total_quantity !== quantity)) throw new Error("Invalid cart counts");
    return;
  }
  const expected = block.kind === "comparison_table" ? "products,rows,sources,title" : "products,sources,title";
  if (fields !== expected || !block.products || !block.sources) throw new Error("Invalid product block");
  const ids = block.products.map(p => p.id);
  if (new Set(ids).size !== ids.length || block.sources.length !== ids.length) throw new Error("Invalid product sources");
  block.products.forEach((p, i) => {
    if (p.route !== `/products/${p.id}` || block.sources?.[i].product_id !== p.id || block.sources[i].route !== p.route) throw new Error("Invalid product route");
  });
  if (block.kind === "product_card" && ids.length !== 1) throw new Error("Invalid card count");
  if (block.kind === "comparison_table" && (ids.length < 2 || !block.rows || block.rows.some(row => row.values.length !== ids.length))) throw new Error("Invalid comparison dimensions");
}
export async function streamAssistant(input: AssistantInput, onEvent: (event: AssistantEvent) => void, signal: AbortSignal, personalize = true): Promise<void> {
  const response = await fetch("/api/v1/assistant/chat", { method: "POST", credentials: "include", headers: {...assistantHeaders(), ...deliveryHeaders(), ...(!personalize ? {"X-Commerce-Personalize":"0"} : {}), "X-Commerce-Assistant-Errors": "1", "X-Commerce-Request-Reference": input.request_id}, body: JSON.stringify(input), signal });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const failure = body && typeof body === "object" && "failure" in body ? parseAssistantFailure(body.failure, input.request_id) : undefined;
    throw new ApiError(failure?.message ?? "Assistant temporarily unavailable. Retry or open a support ticket.", response.status, failure);
  }
  if (!response.headers.get("content-type")?.startsWith("text/event-stream") || !response.body) throw new Error("Assistant stream unavailable");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", {fatal:true});
  let buffer = "", bytes = 0, sequence = 0, done = false, rich = false, clearedComparison = false;
  try {
    while (!done) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65536) throw new Error("Assistant response too large");
      buffer += decoder.decode(part.value,{stream:true});
      let end: number;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0,end); buffer = buffer.slice(end+2);
        const data = block.split("\n").filter(line => line.startsWith("data: ")).map(line => line.slice(6)).join("\n");
        if (!data) continue;
        const event = parseAssistantEvent(data,input.request_id,sequence++);
        if (event.code === "clear_comparison") {
          if (clearedComparison) throw new Error("Repeated comparison command");
          clearedComparison = true;
        }
        // Text deltas append to one response: an acknowledgment can precede tool results.
        if (event.type === "content.blocks") {
          if (rich || new TextEncoder().encode(JSON.stringify(event.blocks)).length > 24576) throw new Error("Rich response too large or repeated");
          rich = true;
        }
        onEvent(event);
        if (event.type === "done") { done = true; break; }
      }
    }
    if (!done) throw new Error("Connection interrupted. Retry or open a support ticket.");
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export async function escalateAssistant(ticket: components["schemas"]["AssistantTicketInput"]): Promise<components["schemas"]["AssistantTicketDetail"]> {
  const abort = new AbortController(); const timer = setTimeout(() => abort.abort(),32000);
  let result: components["schemas"]["AssistantTicketDetail"] | undefined;
  try {
    await streamAssistant({request_id:ticket.request_id,message:"Please open this support ticket.",ticket},event=>{if(event.type === "ticket.created")result=event.ticket;},abort.signal);
    if (!result) throw new Error("Support handoff unavailable");
    return result;
  } finally {clearTimeout(timer);}
}

export function parseAssistantHistory(value: unknown): components["schemas"]["AssistantHistoryTurn"][] {
  if (!Array.isArray(value) || value.length > 100 || !value.every(turn => validates(turn, assistantSchemas.AssistantHistoryTurn))) throw new Error("History unavailable");
  for (const turn of value as components["schemas"]["AssistantHistoryTurn"][]) for (const block of turn.blocks ?? []) validateBlock(block);
  return value as components["schemas"]["AssistantHistoryTurn"][];
}

export async function assistantFeedback(request_id: string, helpful: boolean): Promise<void> {
  const response = await fetch('/api/v1/assistant/feedback', { method:'POST', credentials:'include', headers:assistantHeaders(), body:JSON.stringify({request_id,helpful}) });
  if (!response.ok) throw new Error('Feedback could not be saved.');
}

export async function saveAssistantDeliveryEvent(conversation_id: string, request_id: string, location_id: string): Promise<void> {
  const response = await fetch('/api/v1/assistant/delivery-event', { method:'POST', credentials:'include', headers:assistantHeaders(), signal:AbortSignal.timeout(8000), body:JSON.stringify({conversation_id,request_id,location_id}) });
  if (!response.ok || (await response.json()).saved !== true) throw new Error('Your location is updated, but this confirmation could not be saved to chat history.');
}
