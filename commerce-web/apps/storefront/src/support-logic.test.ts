import { describe, expect, it } from "vitest";
import type { SupportDetail, SupportTicket } from "@commerce/api-client";
import {
  humanizeSupportValue,
  supportLastMessage,
  supportNextAction,
  supportPriorityTone,
  supportSlaLabel,
  supportStatusTone,
} from "./support-logic";

function ticket(
  status: SupportTicket["status"],
  priority: SupportTicket["priority"] = "normal",
): SupportTicket {
  return {
    id: "ticket-id",
    number: 42,
    subject: "Missing item",
    category: "order_issue",
    status,
    priority,
    order_id: null,
    created_at: "2026-09-15T08:00:00Z",
  };
}

describe("support ticket regression behavior", () => {
  it("humanizes API enum values for display", () => {
    expect(humanizeSupportValue("payment_dispute")).toBe("payment dispute");
  });

  it("maps ticket statuses to enterprise badge tones", () => {
    expect(supportStatusTone("open")).toBe("danger");
    expect(supportStatusTone("in_progress")).toBe("pending");
    expect(supportStatusTone("resolved")).toBe("success");
    expect(supportStatusTone("closed")).toBe("success");
  });

  it("marks high-priority tickets as urgent", () => {
    expect(supportPriorityTone("high")).toBe("danger");
    expect(supportPriorityTone("normal")).toBe("pending");
  });

  it("shows SLA labels based on priority and completion state", () => {
    expect(supportSlaLabel(ticket("open", "high"))).toBe("Priority response");
    expect(supportSlaLabel(ticket("open", "normal"))).toBe("Standard response");
    expect(supportSlaLabel(ticket("resolved", "high"))).toBe("Completed");
  });

  it("shows the operational next action for each status", () => {
    expect(supportNextAction(ticket("open"))).toBe("Awaiting first response");
    expect(supportNextAction(ticket("in_progress"))).toBe("Team is investigating");
    expect(supportNextAction(ticket("resolved"))).toBe("Review resolution");
    expect(supportNextAction(ticket("closed"))).toBe("Closed");
  });

  it("returns the last conversation message from ticket detail", () => {
    const detail = {
      ticket: ticket("in_progress"),
      contact_name: null,
      contact: null,
      messages: [
        {
          id: "message-1",
          sender: "customer",
          body: "Hello",
          created_at: "2026-09-15T08:00:00Z",
        },
        {
          id: "message-2",
          sender: "admin",
          body: "We are checking.",
          created_at: "2026-09-15T08:10:00Z",
        },
      ],
    } as SupportDetail;

    expect(supportLastMessage(detail)?.id).toBe("message-2");
    expect(supportLastMessage(undefined)).toBeUndefined();
  });
});
