import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ReasonField, orderReasonOptions, reasonOptions } from "./reason-field";

it("requires an explicit choice without submitting a default audit reason", () => {
  const html = renderToStaticMarkup(<ReasonField label="Adjustment reason" name="reason" options={reasonOptions.inventory} />);
  expect(html).toContain('<option value="" selected="">Select a reason</option>');
  expect(html).toContain('name="reason" value=""');
  expect(html).toContain('required=""');
});

it("submits readable preset reasons through FormData", () => {
  const html = renderToStaticMarkup(<ReasonField label="Adjustment reason" name="reason" options={reasonOptions.inventory} value="Stock count correction" />);
  expect(html).toContain('name="reason" value="Stock count correction"');
  expect(html).not.toContain('<textarea');
});

it("preserves custom reasons and requires their explanation", () => {
  const html = renderToStaticMarkup(<ReasonField label="Reason" name="reason" options={reasonOptions.inventory} value="  Correction after recount  " />);
  expect(html).toContain('<option value="__other" selected="">');
  expect(html).toMatch(/<textarea[^>]*required=""[^>]*maxLength="300"/);
  expect(html).toContain('name="reason" value="Correction after recount"');
});

it("provides reasons for every actionable order transition", () => {
  for (const action of ["confirmed", "fulfilling", "cancelled", "dispatch", "delivered", "delivery_failed", "refund", "cash_collected", "pickup_ready", "picked_up"]) {
    expect(orderReasonOptions(action).length).toBeGreaterThan(0);
  }
  expect(orderReasonOptions("delivery_failed")).not.toContain("Delivery confirmed by carrier");
  expect(orderReasonOptions("refund")).toContain("Duplicate payment");
});
