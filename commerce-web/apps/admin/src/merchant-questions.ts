import type { MerchantInput } from "@commerce/api-client";
export const merchantQuestions = [
  { question: "orders", setup: "quick", label: "Summarize today's orders" },
  { question: "low_stock", setup: "details", label: "Show low-stock products" },
  { question: "top_sellers", setup: "quick", label: "Show weekly top sellers" },
  { question: "slow_stock", setup: "details", label: "Show high-stock, low-sales products" },
  { question: "category_decline", setup: "details", label: "Which categories declined?" },
  { question: "order_status", setup: "details", label: "Look up an order's status" },
] as const;
export const merchantQuestionLabels: Record<MerchantInput["question"], string> = {
  orders: "Summarize orders", low_stock: "Show low-stock products", top_sellers: "Show top sellers",
  slow_stock: "Show high-stock, low-sales products", category_decline: "Which categories declined?", order_status: "Look up an order's status",
};
const aliases: Record<MerchantInput["question"], string[]> = {
  orders: ["summarize orders", "order summary", "show order summary", "how many orders do we have", "how are orders doing", "show me our orders", "how many orders", "show orders", "summarize orders"],
  low_stock: ["what is running low", "what's running low", "which products are low on stock", "which products need restocking", "show low stock", "low stock products", "low inventory"],
  top_sellers: ["show top sellers", "best selling products", "best-selling products", "show best sellers", "what are our best sellers", "which products sell the most", "top products by ordered units", "top sellers", "what are our top sellers"],
  slow_stock: ["which products are selling slowly", "slow moving stock", "show slow-moving products", "high stock low sales", "show slow stock"],
  category_decline: ["which categories are declining", "show declining categories", "category sales decline", "which categories lost sales"],
  order_status: ["look up an order", "check order status", "show order status", "track an order", "order status"],
};
// Whole-request matching: extra filters, negation and conflicting actions are never discarded.
export function merchantQuestion(text: string): MerchantInput["question"] | undefined {
  const normalize = (s: string) => s.trim().toLowerCase().replace(/[’']/g, "'").replace(/[?.!]+$/, "").replace(/\s+/g, " ");
  const q = normalize(text).replace(/^(?:(?:please|pls) |(?:can|could|would) you (?:please )?)/, "").replace(/ (?:please|pls)$/, "");
  const base = q.replace(/ (?:today|yesterday|this week|last week|this month|last month|last 7 days)$/, "");
  const question = merchantQuestions.find(item => normalize(item.label) === q || aliases[item.question].includes(base))?.question;
  if (question === "low_stock" && base !== q && !q.endsWith(" today")) return undefined;
  return question;
}
export function merchantDates(question: MerchantInput["question"], now = new Date()): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const date = new Date(`${to}T00:00:00Z`);
  if (["top_sellers", "slow_stock", "category_decline"].includes(question)) date.setUTCDate(date.getUTCDate() - 6);
  return { from: date.toISOString().slice(0, 10), to };
}

export function merchantDatesForText(text: string, now = new Date()): { from: string; to: string } | undefined {
  const question = merchantQuestion(text);
  if (!question) return undefined;
  const value = text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?.!]+$/, '').replace(/ (please|pls)$/, '');
  const today = now.toISOString().slice(0, 10);
  const start = new Date(`${today}T00:00:00Z`), end = new Date(start);
  const period = value.match(/(?:^| )(today|yesterday|this week|last week|this month|last month|last 7 days)$/)?.[1];
  if (!period) return /today|weekly/.test(value) ? merchantDates(question, now) : undefined;
  if (period === 'yesterday') { start.setUTCDate(start.getUTCDate() - 1); end.setUTCDate(end.getUTCDate() - 1); }
  if (period === 'last 7 days') start.setUTCDate(start.getUTCDate() - 6);
  if (period === 'this week' || period === 'last week') {
    start.setUTCDate(start.getUTCDate() - (start.getUTCDay() + 6) % 7);
    if (period === 'last week') { end.setTime(start.getTime() - 86400000); start.setUTCDate(start.getUTCDate() - 7); }
  }
  if (period === 'this month' || period === 'last month') {
    start.setUTCDate(1);
    if (period === 'last month') { end.setTime(start.getTime() - 86400000); start.setUTCMonth(start.getUTCMonth() - 1); }
  }
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}
