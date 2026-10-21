import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync(new URL("../../packages/api-client/src/theme-contract.json", import.meta.url), "utf8"));
const customer = { id: "11111111-1111-4111-8111-111111111111", email: "shopper@example.test", verified: true };
const storefrontUrl = process.env.STOREFRONT_URL || "http://127.0.0.1:5185/";

for (const shopper of ["guest", "customer"] as const) {
for (const [store, style] of [["grocery", "standard"], ["jewelry", "heritage"], ["electronics", "showcase"]] as const) {
  for (const width of [390, 1440]) {
    test(`${store} ${shopper} can browse without selecting delivery at ${width}px`, async ({ page }, info) => {
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.setViewportSize({ width, height: 900 });
      const theme = structuredClone(contract.default);
      theme.global.top.push({ id: "delivery-test-presentation", component: "presentation", version: 1, enabled: true, settings: { style } });
      await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        if (path.includes("/theme/")) return route.fulfill({ json: { configuration: theme, cities: [] } });
        if (path.endsWith("/auth/refresh")) return route.fulfill(shopper === "guest" ? { status: 401, json: { error: "Unauthorized" } } : { json: { customer, access_token: "test-token" } });
        if (path.endsWith("/customer/me")) return route.fulfill({ json: customer });
        if (path.endsWith("/languages")) return route.fulfill({ json: { source_locale: "en", languages: [] } });
        if (path.endsWith("/cart")) return route.fulfill({ json: { items: [], subtotal: "0.00", currency: "USD" } });
        if (path.endsWith("/search")) return route.fulfill({ json: { hits: [], total: 0, facets: {} } });
        if (path.includes("/content/")) return route.fulfill({ status: 404, json: { error: "No published content" } });
        if (path.includes("/delivery-area")) return route.fulfill({ json: { configured: false, deliverable: true } });
        return route.fulfill({ json: [] });
      });
      await page.goto(storefrontUrl);
      const header = page.locator(".store-header");
      const delivery = header.getByRole("link", { name: /^Deliver to/ });
      await expect(delivery).toBeVisible();
      await expect(page).toHaveURL(storefrontUrl);
      if (style !== "standard") {
        await expect(header.locator("#header-search")).toBeHidden();
        await expect(header.locator(".header-delivery-zone")).toContainText("Deliver to");
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await header.screenshot({ path: info.outputPath("delivery-header.png") });
      await delivery.click();
      await expect(page).toHaveURL(/\/delivery-location\?returnTo=/);
      await expect(page.getByRole("heading", { name: "Where should we deliver?", exact: true })).toBeVisible();
      await page.locator(".back-link").click();
      await expect(page).toHaveURL(storefrontUrl);
      await expect(delivery).toBeVisible();
      for (const path of ["/search", "/cart", "/compare"]) {
        await page.goto(new URL(path, storefrontUrl).href);
        await expect(delivery).toBeVisible();
        await expect(page).toHaveURL(new URL(path, storefrontUrl).href);
      }
      expect(errors).toEqual([]);
    });
  }
}
}
