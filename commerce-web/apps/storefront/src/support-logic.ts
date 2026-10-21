import type { SupportDetail, SupportInput, SupportTicket } from "@commerce/api-client";

export const supportStatuses: SupportTicket["status"][] = [
  "open",
  "in_progress",
  "resolved",
  "closed",
];

export const supportCategories: SupportInput["category"][] = [
  "order_issue",
  "product_question",
  "complaint",
  "payment_dispute",
  "other",
];

export function humanizeSupportValue(value: string) {
  return value.replaceAll("_", " ");
}

export function supportStatusTone(status: SupportTicket["status"]) {
  if (status === "resolved" || status === "closed") return "success";
  if (status === "in_progress") return "pending";
  return "danger";
}

export function supportPriorityTone(priority: SupportTicket["priority"]) {
  return priority === "high" ? "danger" : "pending";
}

export function supportSlaLabel(ticket: Pick<SupportTicket, "priority" | "status">) {
  if (ticket.status === "resolved" || ticket.status === "closed") {
    return "Completed";
  }
  return ticket.priority === "high" ? "Priority response" : "Standard response";
}

export function supportNextAction(ticket: Pick<SupportTicket, "status">) {
  if (ticket.status === "open") return "Awaiting first response";
  if (ticket.status === "in_progress") return "Team is investigating";
  if (ticket.status === "resolved") return "Review resolution";
  return "Closed";
}

export function supportLastMessage(detail: SupportDetail | undefined) {
  return detail?.messages.at(-1);
}
