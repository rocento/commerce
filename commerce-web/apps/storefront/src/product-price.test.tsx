import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CatalogPrice, ProductPrice } from "./product-price";
it("labels original, discounted and saved prices accessibly", () => {
  const html = renderToStaticMarkup(<ProductPrice price="7.50" originalPrice="10" currency="USD" unit="pack"/>);
  expect(html).toContain("<del>$10.00</del>");
  expect(html).toContain("Discounted price:");
  expect(html).toContain("$7.50");
  expect(html).toContain("25% off");
  expect(html).toContain("You save $2.50");
});
it.each([undefined, "0", "7.50", "5", "invalid"])("does not invent a discount for invalid original price %s", originalPrice => {
  const html = renderToStaticMarkup(<ProductPrice price="7.50" originalPrice={originalPrice} currency="USD"/>);
  expect(html).not.toContain("<del>");
  expect(html).not.toContain("% off");
});

it("rejects mismatched offers on product cards", () => {
  const product = { id: 'p1', price: '100.00', currency: 'USD', catalog_offer: { product_id: 'p2', original_price: '100.00', discounted_price: '90.00', currency: 'USD' } } as import('@commerce/api-client').Product;
  const html = renderToStaticMarkup(<CatalogPrice product={product}/>);
  expect(html).toContain('$100.00');
  expect(html).not.toContain('$90.00');
  expect(html).not.toContain('Discounted price:');
});
