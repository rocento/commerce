import { ApiError, type AssistantEvent, type AssistantInput, type SupportDetail } from "@commerce/api-client";
export type Message = {
  role: "customer" | "assistant";
  text: string;
  failure?: string;
  requestId?: string;
  order?: AssistantEvent["order"];
  orders?: NonNullable<AssistantEvent["order"]>[];
  orderPicker?: boolean;
  reorder?: { id: string; number: number };
  ticket?: SupportDetail;
  login?: boolean;
  helpful?: boolean | null;
  saved?: boolean;
  completed?: boolean;
  clarification?: AssistantEvent["clarification"];
  responseSource?: "R" | "L" | null;
  createdAt?: string;
  blocks?: AssistantEvent["blocks"];
};
export const progressLabels = {
  preparing: "Understanding your request…",
  catalog: "Checking current catalog details…",
  order: "Checking your order…",
  support: "Opening your support ticket…",
  responding: "Preparing your response…",
} as const;
export function startMessages(messages: Message[], input: AssistantInput, retry: boolean, previousId?: string, displayMessage?: string): Message[] {
  const index = messages.findIndex(m => m.role === "assistant" && m.requestId === previousId);
  if (retry && index >= 0) return messages.map((m, i) => i === index ? { role: "assistant", text: "", requestId: input.request_id } : m);
  return [...messages, { role: "customer", text: displayMessage ?? input.message }, { role: "assistant", text: "", requestId: input.request_id }];
}
export function updateMessage(messages: Message[], event: AssistantEvent): Message[] {
  const index = messages.findIndex(m => m.role === "assistant" && m.requestId === event.request_id);
  const current = messages[index];
  if (!current || current.role !== "assistant") return messages;
  let next = current;
  if (event.type === "message.delta") next = { ...current, text: (current.text + (event.text ?? "")).slice(0, 8000), login: event.code === "login_required" || current.login };
  if (event.clarification) next = { ...next, clarification: event.clarification };
  if (event.type === "done") next = { ...current, saved:event.saved, completed: true };
  if (event.type === "content.blocks") next = { ...current, blocks: event.blocks };
  if (event.type === "card.order" && event.order) next = { ...current, order: event.order, orders: [...(current.orders ?? []), event.order] };
  if (event.type === "ticket.created" && event.ticket) next = { ...current, ticket: event.ticket };
  if (event.response_source) next = { ...next, responseSource: current.responseSource === "L" ? "L" : event.response_source };
  return next === current ? messages : messages.map((m, i) => i === index ? next : m);
}
export function assistantFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.failure) return `${error.failure.message} Reference: ${error.failure.request_reference}`;
    if (error.status === 401) return "Please sign in again to continue.";
    if (error.status === 503) return "The assistant service is unavailable. Please retry or contact support. (HTTP 503)";
    if (error.status === 429) return "The assistant is busy. Please try again in a moment.";
  }
  return "The assistant is unavailable or the connection was interrupted. Please retry or contact support.";
}

export function streamFailure(event: AssistantEvent): string {
  if (event.failure) return `${event.failure.message} Reference: ${event.failure.request_reference}`;
  return event.code === "login_required" ? "Please sign in again to continue." : assistantFailure(undefined);
}
