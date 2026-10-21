import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { AssistantMarkdown, safeAssistantLink } from "./assistant-markdown";
const render = (text: string) => renderToStaticMarkup(<StaticRouter location="/assistant"><AssistantMarkdown text={text} /></StaticRouter>);
it("renders headings, lists, emphasis, code and product links as safe prose", () => {
  const html = render("## Matches\n\n- **Shoes**\n  Size 42\n- *Black*\n\n`USD`\n\n```\n<example>\n```\n/products/12345678-1234-1234-1234-123456789abc");
  expect(html).toContain("<h3>Matches</h3>");
  expect(html).toContain("<ul>");
  expect(html).toContain("<strong>Shoes</strong>");
  expect(html).toContain("<em>Black</em>");
  expect(html).toContain("&lt;example&gt;");
  expect(html).toContain('href="/products/12345678-1234-1234-1234-123456789abc"');
});
it.each(["javascript:alert(1)", "data:text/html,hi", "//evil.test", "/api/v1/delete", "https://user:secret@evil.test"])("rejects unsafe or privileged links: %s", value => expect(safeAssistantLink(value)).toBeUndefined());
it("escapes HTML and does not load remote images or raw markup", () => {
  const html = render('<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n![image](https://example.com/a.png)\n[bad](javascript:alert)');
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript:');
});
it("handles incomplete streamed markup and safely opens cited HTTPS links", () => {
  expect(render("**incomplete")).toContain("incomplete");
  expect(render("[Guide](https://example.com/guide)")).toContain('rel="noopener noreferrer"');
  expect(render("1. First\n2. Second")).toContain("<ol>");
});
it.each(["https:\\evil.test", "https://example.com/\nprivate", "\thttps://example.com", "https://example.com/\u007f", "java\nscript:alert(1)"])("rejects URLs requiring unsafe normalization: %s", value => expect(safeAssistantLink(value)).toBeUndefined());

it.each(["/cart", "/checkout"])("allows cart navigation: %s", value => expect(safeAssistantLink(value)).toBe(value));

it.each(["/support", "/delivery-location", "/account/orders", "/account/wishlist", "/account/locations", "/account/locations/new", "/register", "/forgot-password"])("renders an allowlisted intent handoff: %s", path => {
  expect(safeAssistantLink(path)).toBe(path);
  const html = render(`[Continue](${path})`);
  expect(html).toContain(`href="${path}"`);
});

it('opens checkout inside the assistant when an inline checkout handler is provided', () => {
  const html = renderToStaticMarkup(<StaticRouter location="/assistant"><AssistantMarkdown
    text="[Continue to checkout](/checkout)" onCheckout={() => {}} /></StaticRouter>);
  expect(html).toContain('<button');
  expect(html).toContain('Continue to checkout');
  expect(html).not.toContain('href="/checkout"');
  expect(render('[Continue to checkout](/checkout)')).toContain('href="/checkout"');
});

it('starts support intake inside chat when a support handler is provided', () => {
  const html = renderToStaticMarkup(<StaticRouter location="/assistant"><AssistantMarkdown
    text="[Open a ticket](/support)" onSupport={() => {}} /></StaticRouter>);
  expect(html).toContain('<button');
  expect(html).toContain('Open a ticket');
  expect(html).not.toContain('href="/support"');
});
