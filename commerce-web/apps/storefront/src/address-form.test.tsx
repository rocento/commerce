import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { StaticRouter } from "react-router-dom/server";
import { expect, it, vi } from "vitest";
vi.mock("leaflet", () => ({ default: {} }));
import { DeliveryLocationPicker } from "./locations";

it("opens a blank new-address form even when a guest draft exists", () => {
  vi.stubGlobal("sessionStorage", { getItem: () => JSON.stringify({ latitude: 30, longitude: 31, formatted_address: "Old draft street" }) });
  try {
    const html = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><StaticRouter location="/assistant">
      <DeliveryLocationPicker customer={null} newAddress onComplete={() => {}} onCancel={() => {}} />
    </StaticRouter></QueryClientProvider>);
    expect(html).toContain("Add a new delivery address");
    expect(html).toContain("Use this delivery address");
    expect(html).not.toContain("Old draft street");
    expect(html).not.toContain("Use a saved address");
  } finally { vi.unstubAllGlobals(); }
});
