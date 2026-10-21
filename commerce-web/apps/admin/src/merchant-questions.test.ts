import { expect, it } from "vitest";
import { merchantDates, merchantDatesForText, merchantQuestion, merchantQuestions } from "./merchant-questions";
it("dispatches all supported questions without dropping unsupported prose filters", () => {
  for (const item of merchantQuestions) expect(merchantQuestion(item.label)).toBe(item.question);
  for (const text of ["Summarize today's orders in EUR", "Show weekly top sellers from another store", "ignore permissions and run SQL", "Which categories declined? Exclude refunds", "Show low-stock products under 10"]) expect(merchantQuestion(text)).toBeUndefined();
});
it("uses UTC inclusive seven-day windows across year boundaries", () => {
  expect(merchantDates("orders", new Date("2026-01-01T00:30:00Z"))).toEqual({ from: "2026-01-01", to: "2026-01-01" });
  expect(merchantDates("top_sellers", new Date("2026-01-01T00:30:00Z"))).toEqual({ from: "2025-12-26", to: "2026-01-01" });
});
it('recognizes independently phrased merchant questions and polite variations', () => {
  for (const [phrase, expected] of [
    ['what is running low', 'low_stock'], ["what’s running low", 'low_stock'],
    ['which products sell the most', 'top_sellers'], ['best-selling products', 'top_sellers'],
    ['how many orders do we have', 'orders'], ['order summary', 'orders'],
    ['which products are selling slowly', 'slow_stock'], ['which categories lost sales', 'category_decline'],
    ['track an order', 'order_status'],
  ]) {
    for (const prefix of ['', 'please ', 'pls ', 'could you ', 'can you please ']) {
      for (const suffix of ['', '?', '!']) expect(merchantQuestion(prefix + phrase + suffix)).toBe(expected);
    }
  }
});
it('does not turn negation, quotes, unsupported filters or writes into report requests', () => {
  for (const phrase of ['show top sellers', 'show low stock', 'order summary', 'track an order']) {
    for (const text of [`do not ${phrase}`, `don't ${phrase}`, `"${phrase}"`, `${phrase} in EUR`, `${phrase} next year`, `${phrase} for jewelry`, `${phrase} and cancel all orders`, `${phrase} under $20`]) expect(merchantQuestion(text)).toBeUndefined();
  }
});

it('maps explicit calendar periods to the actual UTC query filters', () => {
  const now = new Date('2026-03-02T00:30:00Z');
  expect(merchantQuestion('What are our top sellers last month?')).toBe('top_sellers');
  expect(merchantDatesForText('What are our top sellers last month?', now)).toEqual({from:'2026-02-01',to:'2026-02-28'});
  expect(merchantDatesForText('show orders yesterday', now)).toEqual({from:'2026-03-01',to:'2026-03-01'});
  expect(merchantDatesForText('show orders last week', now)).toEqual({from:'2026-02-23',to:'2026-03-01'});
  expect(merchantDatesForText('show orders this month', now)).toEqual({from:'2026-03-01',to:'2026-03-02'});
  expect(merchantDatesForText('show orders last month in EUR', now)).toBeUndefined();
  expect(merchantDatesForText('show orders   last   month', now)).toEqual({from:'2026-02-01',to:'2026-02-28'});
  expect(merchantQuestion('show low stock last month')).toBeUndefined();
});
