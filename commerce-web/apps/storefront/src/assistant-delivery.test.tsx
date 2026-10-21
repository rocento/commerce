import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { AddToCart } from "./cart";
import { AssistantDeliveryContext } from "./assistant-delivery-context";

const state = vi.hoisted(() => ({ key: "none", configured: true }));
vi.mock("./locations", () => ({
  useDeliveryKey: () => state.key,
  useDeliveryStatus: () => ({ data: { configured: state.configured } }),
}));
beforeEach(() => { state.key = "none"; state.configured = true; });
const render = (assistant = true) => renderToStaticMarkup(
  <QueryClientProvider client={new QueryClient()}><StaticRouter location="/assistant">
    <AssistantDeliveryContext.Provider value={assistant ? { requestLocation: vi.fn(), requestNewAddress: vi.fn(), subscribeToUpdates: () => () => {} } : null}>
      <AddToCart id="00000000-0000-4000-8000-000000000001" productName="Fresh fish" />
    </AssistantDeliveryContext.Provider>
  </StaticRouter></QueryClientProvider>,
);
it("offers an enabled address picker instead of an unavailable add control when delivery requires a location", () => {
  const html = render();
  expect(html).toContain("Choose delivery address");
  expect(html).not.toContain("disabled");
  expect(html).not.toContain('aria-label="Add Fresh fish to cart"');
});
it("checks live stock normally after a location is selected", () => {
  state.key = "30,31";
  expect(render()).not.toContain("Choose delivery address");
});
it("does not demand an address when delivery areas are not configured", () => {
  state.configured = false;
  expect(render()).not.toContain("Choose delivery address");
});
it("preserves purchase controls outside the assistant", () => {
  expect(render(false)).not.toContain("Choose delivery address");
});
