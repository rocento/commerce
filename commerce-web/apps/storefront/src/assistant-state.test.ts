import { describe, expect, it } from "vitest";
import { ApiError, type AssistantEvent } from "@commerce/api-client";
import { assistantFailure, streamFailure, startMessages, updateMessage } from "./assistant-state";
const input = { request_id: "12345678-1234-1234-1234-123456789abc", message: "Find shoes" };
const event = (text: string, id = input.request_id): AssistantEvent => ({ version: "1", request_id: id, sequence: 0, type: "message.delta", text });
it("retains the response source through streaming and completion, and clears it on retry", () => {
  let messages = updateMessage(startMessages([], input, false), { ...event("Engine"), response_source: "R" });
  expect(messages[1].responseSource).toBe("R");
  messages = updateMessage(messages, { ...event("Model"), response_source: "L" });
  messages = updateMessage(messages, { ...event(""), type: "done", response_source: "R" });
  expect(messages[1].responseSource).toBe("L");
  expect(messages[1].completed).toBe(true);
  expect(startMessages(messages, input, true, input.request_id)[1].responseSource).toBeUndefined();
});
describe("assistant conversation state", () => {
  it("accumulates chunks only into their own request, even with a support update after it", () => {
    const messages = [...startMessages([], input, false), { role: "assistant" as const, text: "Support update" }];
    const next = updateMessage(updateMessage(messages, event("Hello")), event(" world"));
    expect(next[1].text).toBe("Hello world");
    expect(next[2].text).toBe("Support update");
    expect(updateMessage(next, event("Late", "another-request"))).toBe(next);
  });
  it("retries the matching response without duplicating its question or removing other updates", () => {
    const messages = [...updateMessage(startMessages([], input, false), event("Partial")), { role: "assistant" as const, text: "Support update" }];
    const retry = startMessages(messages, { ...input, request_id: "retry" }, true, input.request_id);
    expect(retry.map(m => m.text)).toEqual(["Find shoes", "", "Support update"]);
    expect(updateMessage(retry, event("stale"))).toBe(retry);
    expect(updateMessage(retry, event("Complete", "retry"))[1].text).toBe("Complete");
  });
  it("never displays raw error messages or credentials", () => {
    expect(assistantFailure(new Error("secret-canary"))).not.toContain("secret-canary");
    expect(assistantFailure(new ApiError("raw", 401))).toContain("sign in");
    expect(assistantFailure(new ApiError("raw", 429))).toContain("busy");
    expect(assistantFailure(new ApiError("secret-canary", 503))).toContain("HTTP 503");
    expect(assistantFailure(new ApiError("secret-canary", 503))).not.toContain("secret-canary");
  });
});
it("keeps friendly comparison labels and replaces rich cards on retry", () => {
  const input = { request_id: "comparison", message: "Compare /products/id1 /products/id2" };
  const messages = startMessages([], input, false, undefined, "Compare Shoes and Boots");
  expect(messages[0].text).toBe("Compare Shoes and Boots");
  const withBlocks = updateMessage(messages, { version: "1", request_id: "comparison", sequence: 0, type: "content.blocks", blocks: [{ kind: "text", text: "Current facts" }] });
  expect(withBlocks[1].blocks).toHaveLength(1);
  const retried = startMessages(withBlocks, { ...input, request_id: "retry" }, true, "comparison");
  expect(retried).toHaveLength(2);
  expect(retried[1].blocks).toBeUndefined();
});

it("shows verified recovery guidance and a support reference, with legacy fallback", () => {
  const frame: AssistantEvent = { ...event("Failed"), type: "error", failure: { code: "authentication_needed", message: "Please sign in again.", retryable: false, recovery: "sign_in", request_reference: input.request_id } };
  expect(streamFailure(frame)).toContain("Please sign in again.");
  expect(streamFailure(frame)).toContain(input.request_id);
  expect(streamFailure({ ...frame, failure: undefined, text: "secret-canary" })).not.toContain("secret-canary");
});

it("keeps structured clarification context through completion and clears it on retry", () => {
  const clarification = { original_message: "add two products to cart", question: "Which product?" };
  let messages = updateMessage(startMessages([], input, false), { ...event(clarification.question), clarification });
  expect(messages[1].clarification).toEqual(clarification);
  expect(messages[1].completed).toBeUndefined();
  messages = updateMessage(messages, { version: "1", request_id: input.request_id, sequence: 1, type: "done" });
  expect(messages[1].clarification).toEqual(clarification);
  expect(messages[1].completed).toBe(true);
  expect(startMessages(messages, input, true, input.request_id)[1].clarification).toBeUndefined();
});
