import { expect, it } from "vitest";
import { validateMerchantAnswer, type MerchantInput } from "./merchant";
const input: MerchantInput = { question: "orders", from: "2026-09-15", to: "2026-09-15", currency: "USD", scope: "installation", stock_threshold: 5, sales_threshold: 2, order_id: null };
const answer = { request_id:"00000000-0000-0000-0000-000000000009",conversation_id:"00000000-0000-0000-0000-000000000009",helpful:null, question: input.question, from: input.from, to: input.to, currency: input.currency, scope: input.scope, title: "Orders", evaluated_at: "2026-09-15T12:00:00Z", columns: ["Status", "Orders"], rows: [["delivered", "2"]], notes: ["Current records"], truncated: false };
it("requires returned scope and dates to match the query", () => {
  expect(validateMerchantAnswer(answer, input)).toEqual(answer);
  for (const change of [{ currency: "EUR" }, { from: "2026-08-01" }, { scope: "other" }, { question: "low_stock" }, { sql: "SELECT" }]) expect(() => validateMerchantAnswer({ ...answer, ...change }, input)).toThrow();
});
it("rejects malformed, oversized or misaligned rows", () => {
  for (const change of [{ columns: [] }, { rows: [["delivered"]] }, { rows: [[{}, "2"]] }, { rows: Array(21).fill(["delivered", "2"]) }, { notes: ["a".repeat(1001)] }, { evaluated_at: "invalid" }]) expect(() => validateMerchantAnswer({ ...answer, ...change }, input)).toThrow();
});
it('rejects responses belonging to another request or conversation', () => {
  const other = '00000000-0000-0000-0000-000000000008';
  expect(() => validateMerchantAnswer(answer, { ...input, request_id: other })).toThrow('another request');
  expect(() => validateMerchantAnswer(answer, { ...input, conversation_id: other })).toThrow('another request');
  expect(validateMerchantAnswer(answer, { ...input, request_id: answer.request_id, conversation_id: answer.conversation_id })).toEqual(answer);
});
