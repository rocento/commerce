import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { type AssistantBlock } from "@commerce/api-client";
import { AssistantRichResponse } from "./assistant-rich";
vi.mock("./locations", () => ({ useDeliveryKey: () => "default", useDeliveryStatus: () => ({ data: undefined }) }));
const id = "12345678-1234-1234-1234-123456789abc";
const product = { id, name: '<img src=x onerror="bad"> Shoes', image_id: null, price: "99", currency: "USD", in_stock: null, route: `/products/${id}`, attributes: [{ name: "size", value: "42" }], reasons: ["Catalog lists size: 42"], unmet: ["brand"] };
const block: AssistantBlock = { kind: "recommendation_group", title: "Alternatives", products: [product], sources: [{ kind: "catalog", product_id: id, route: product.route }] };
const render = (b: AssistantBlock) => renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><StaticRouter location="/assistant"><AssistantRichResponse blocks={[b]} busy={false} onCompare={() => {}} /></StaticRouter></QueryClientProvider>);
it("renders facts and unmet requirements without recommendation explanations or unknown stock labels", () => {
  const html = render(block);
  expect(html).not.toContain("Availability unknown");
  expect(html).not.toContain("Why this appears");
  expect(html).toContain("Image unavailable");
  expect(html).not.toContain("Catalog lists size: 42");
  expect(html).toContain("Unmet or unverified");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).not.toContain(`href="${product.route}"`);
  expect(html).toContain('aria-label="Product details for ');
});
it("renders accessible comparison rows and loads images only from catalog media IDs", () => {
  const other = { ...product, id: "00000000-0000-0000-0000-000000000002", image_id: id };
  const html = render({ ...block, kind: "comparison_table", products: [product, other], rows: [{ label: "size", values: ["42", "Not provided"] }] });
  expect(html).toContain('scope="row"');
  expect(html).toContain("Not provided");
  expect(html).toContain(`/api/v1/catalog/media/${id}/content`);
  expect(html).toContain('role="region"');
});

it("offers a labeled purchase control and keeps it disabled until live cart and stock load", () => {
  const html = render({ ...block, products: [{ ...product, name: "Red Apples", in_stock: true }] });
  expect(html).toContain('aria-label="Add Red Apples to cart"');
  expect(html).toMatch(/<button[^>]*disabled/);
});

it("shows cart snapshot facts with expandable product details", () => {
  const html = render({kind:"cart_summary",cart:{items:[{product_id:id,name:'<img src=x onerror="bad"> Tea',quantity:2,price:"3.00",line_total:"6.00",currency:"USD"}],total_lines:1,total_quantity:2,subtotal:"6.00",discount_amount:"1.00",currency:"USD",fully_reserved:false}});
  expect(html).toContain("Quantity: 2");
  expect(html).toContain("$3.00");
  expect(html).toContain("6.00 USD");
  expect(html).toContain("Current discount");
  expect(html).toContain("not currently reserved");
  expect(html).not.toContain(`href="/products/${id}"`);
  expect(html).toContain('details" aria-expanded="false"');
  expect(html).not.toContain('class="assistant-cart-open"');
  expect(html).not.toContain('href="/cart"');
  expect(html).toContain("&lt;img");
  expect(html).not.toContain("<img");
  expect(html).toContain("Cart snapshot");
});
it("renders empty carts without a reservation warning", () => {
  const html = render({kind:"cart_summary",cart:{items:[],total_lines:0,total_quantity:0,subtotal:"0",discount_amount:"0",currency:"USD",fully_reserved:false}});
  expect(html).toContain("Your cart is empty");
  expect(html).not.toContain('href="/cart"');
  expect(html).not.toContain("not currently reserved");
});

it("shows original and discounted prices from typed promotion evidence", () => {
  const html = render({ ...block, products: [{ ...product, price: "75", original_price: "100" }] });
  expect(html).toContain("<del>$100.00</del>");
  expect(html).toContain("$75.00");
  expect(html).toContain("25% off");
  expect(html).toContain("You save $25.00");
});

it("shows a compact removal receipt with catalog image, name, quantities and subtotal, without purchase controls", () => {
  const cache = new QueryClient();
  cache.setQueryData(["cart-product", id], { media_ids: [id] });
  const html = renderToStaticMarkup(<QueryClientProvider client={cache}><StaticRouter location="/assistant">
    <AssistantRichResponse busy={false} onCompare={() => {}} blocks={[{ kind: "cart_removal", cart_removal: {
      product_id: id, name: "Gala Apples 1kg", quantity: 3, remaining_quantity: 0,
      cart_quantity: 8, cart_subtotal: "20.00", currency: "USD",
    } }]} />
  </StaticRouter></QueryClientProvider>);
  for (const text of ["Removed from cart", "Gala Apples 1kg", "Quantity removed: 3", "All units removed", "8 items in your cart", "Subtotal: 20.00 USD"]) expect(html).toContain(text);
  expect(html).toContain(`/api/v1/catalog/media/${id}/content`);
  expect(html).not.toContain("<button");
  expect(html).not.toContain("Choose a product");
  expect(html).not.toContain("Your cart</");
  cache.clear();
});

it("shows a compact confirmation first, retaining the requested quantity without purchase controls", () => {
  const html = render({ kind: "cart_removal_choice", cart_removal_choice: { quantity: 2, items: [
    { product_id: id, name: "Gala Apples 1kg", quantity: 3, price: "2.50", line_total: "7.50", currency: "USD" },
  ] } });
  expect(html).toContain("Remove from cart?");
  expect(html).toContain("Gala Apples 1kg");
  expect(html).toContain("Quantity to remove: 2");
  expect(html).toContain("Confirm removal");
  expect(html).not.toContain("Add to cart");
  expect(html).not.toContain("<input");
});

it("asks which cart item to remove when multiple items match", () => {
  const html = render({ kind: "cart_removal_choice", cart_removal_choice: { quantity: null, items: [
    { product_id: id, name: "Gala Apples 1kg", quantity: 3, price: "2.50", line_total: "7.50", currency: "USD" },
    { product_id: "00000000-0000-0000-0000-000000000002", name: "Gala Apples 500g", quantity: 1, price: "1.50", line_total: "1.50", currency: "USD" },
  ] } });
  expect(html).toContain("Choose a product to remove");
  expect(html).toContain("Confirm removal of all 3");
  expect(html).toContain("Confirm removal of all 1");
  expect(html).not.toContain("Add to cart");
});

it("renders wishlist management with explicit removal instead of a purchase control", () => {
  const html = render({ ...block, kind: "wishlist_manage", products: [{ ...product, name: "Red Apples" }] });
  expect(html).toContain("Confirm removal of Red Apples from wishlist");
  expect(html).not.toContain('aria-label="Add Red Apples to cart"');
});

it.each<AssistantBlock>([
  { kind: 'text', text: '[Open a ticket](/support)' },
])('keeps support handoffs in the chat: $kind', block => {
  const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><StaticRouter location="/assistant">
    <AssistantRichResponse blocks={[block]} busy={false} onCompare={() => {}} onSupport={() => {}} />
  </StaticRouter></QueryClientProvider>);
  expect(html).toContain('<button');
  expect(html).toContain('Open a ticket');
  expect(html).not.toContain('href="/support"');
});
