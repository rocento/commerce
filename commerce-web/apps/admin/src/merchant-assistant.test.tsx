import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MerchantResult } from "./merchant-assistant";
it("renders database strings without HTML or floating-point rounding", () => {
  const html = renderToStaticMarkup(<MerchantResult answer={{ request_id:"00000000-0000-0000-0000-000000000009",conversation_id:"00000000-0000-0000-0000-000000000009",helpful:null,question: "orders", from: "2026-09-15", to: "2026-09-15", currency: "USD", scope: "installation", evaluated_at: "2026-09-15T12:00:00Z", title: "Order values", columns: ["Status", "Value"], rows: [["<script>bad</script>", "9007199254740993.01"]], notes: ["Cancelled orders shown separately"], truncated: false }} />);
  expect(html).toContain("9007199254740993.01");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("Cancelled orders shown separately");
  expect(html).toContain('scope="col"');
});
