import { expect, it } from "vitest";
import { parseSelection, selectionInput, selectionForMessage } from "./assistant-selection";

const id = "00000000-0000-4000-8000-000000000001";
it("restores product and cart contexts without storing stale commerce facts", () => {
  expect(parseSelection(JSON.stringify({ kind: "product", id, name: "Apples", price: "old price" }))).toEqual({ kind: "product", id, name: "Apples" });
  expect(parseSelection('{"kind":"cart","total":100}')).toEqual({ kind: "cart" });
});
it("retains saved order context from the previous format", () => {
  expect(parseSelection(JSON.stringify({ id, number: 6 }))).toEqual({ kind: "order", id, number: 6 });
});
it("ignores corrupt or invalid saved selections", () => {
  for (const saved of ["invalid", "null", "[]", '{"kind":"product","id":"invalid","name":"Apple"}', JSON.stringify({ kind: "product", id, name: "" })]) expect(parseSelection(saved)).toBeUndefined();
});
it("sends only the current context and sends none after clearing", () => {
  expect(selectionInput({ kind: "order", id, number: 6 })).toEqual({ order_id: id });
  expect(selectionInput({ kind: "product", id, name: "Apples" })).toEqual({ product_id: id });
  expect(selectionInput({ kind: "cart" })).toEqual({ cart_context: true });
  expect(selectionInput()).toEqual({});
});

it("carries only bounded follow-ups and drops stale targets for fresh requests", () => {
  const product = { kind: "product" as const, id, name: "Apples" };
  const cart = { kind: "cart" as const };
  const order = { kind: "order" as const, id, number: 6 };
  for (const text of ["price?", "availability /", "add 2", "tell me about it"]) expect(selectionForMessage(product, text)).toEqual(product);
  for (const text of ["total?", "how many items?", "what is in it"]) expect(selectionForMessage(cart, text)).toEqual(cart);
  expect(selectionForMessage(order, "where is it?")).toEqual(order);
  for (const target of [product, cart, order]) {
    for (const text of ["find headphones", "add 2 bananas to cart", "show my first order", "do not add it", "price / remove it", "shipping fees"]) expect(selectionForMessage(target, text)).toBeUndefined();
  }
  expect(selectionForMessage(undefined, "add 2")).toBeUndefined();
});
