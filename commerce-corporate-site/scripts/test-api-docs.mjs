// Browser regressions against an already-running static export:
// API_DOCS_BASE_URL=http://127.0.0.1:5180 node scripts/test-api-docs.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, expect } from "@playwright/test";

const base = new URL(process.env.API_DOCS_BASE_URL || "http://127.0.0.1:5180");
assert(["http:", "https:"].includes(base.protocol), "Use an HTTP(S) preview origin");
const browser = await chromium.launch({ headless: true });
const requests = [];
const pageErrors = [];
const blockedRequests = [];
const credentialRequests = [];
const override = "?url=https%3A%2F%2Funtrusted.example.invalid%2Fopenapi.json&configUrl=https%3A%2F%2Funtrusted.example.invalid%2Fconfig.json";

async function expectReadOnly(frame) {
  assert.equal(await frame.locator("button.authorize, button.authorization__btn").count(), 0, "Credentials must not be accepted by the viewer");
  assert.equal(await frame.getByRole("button", { name: /^(try it out|execute|authorize)$/i }).count(), 0, "API execution and authorization controls must be absent");
}

async function expectNoOverflow(frame, label) {
  const size = await frame.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    overflowing: [...document.querySelectorAll("body *")].filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.right > document.documentElement.clientWidth + 1 && rect.width > 0;
    }).slice(0, 8).map((element) => `${element.tagName.toLowerCase()}.${element.className}`),
  }));
  assert(size.document <= size.viewport + 1 && size.body <= size.viewport + 1, `${label} overflows horizontally: ${JSON.stringify(size)}`);
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([{ name: "api_docs_probe", value: "synthetic-no-secret", url: base.origin }]);
  // Fail safely if a regression tries to send a request outside the preview.
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ url: request.url(), method: request.method() });
    if (url.pathname === "/docs/api/openapi.json") {
      const headers = await request.allHeaders();
      if (headers.cookie || headers.authorization) credentialRequests.push(request.url());
    }
    // Next's navigation may probe local static routes with HEAD.
    if (url.origin !== base.origin || !["GET", "HEAD"].includes(request.method())) {
      blockedRequests.push({ url: request.url(), method: request.method() });
      await route.abort();
      return;
    }
    await route.continue();
  });
  context.on("page", (page) => page.on("pageerror", (error) => pageErrors.push(error.message)));
  const page = await context.newPage();
  const response = await page.goto(new URL(`/docs/api/${override}`, base).href, { waitUntil: "networkidle" });
  assert.equal(response.status(), 200, "The API documentation route must exist");
  assert.equal(await page.locator("h1").count(), 1, "The overview needs one main heading");
  const iframe = page.locator("iframe");
  assert.equal(await iframe.count(), 1, "The overview must embed the isolated reference");
  const reference = await (await iframe.elementHandle()).contentFrame();
  assert(reference, "The embedded reference must load");
  await reference.locator(".swagger-ui .opblock").first().waitFor();
  assert.match(await reference.locator(".swagger-ui .info .title").innerText(), /Rocento Storefront and Customer API/);
  assert(await reference.locator(".opblock").count() > 10, "Published operations must render");
  await expectReadOnly(reference);

  const originalCount = await reference.locator(".opblock").count();
  const filter = reference.getByPlaceholder("Filter by tag");
  await filter.fill("Customer account");
  await expect.poll(() => reference.locator(".opblock").count()).toBeLessThan(originalCount);
  const filteredCount = await reference.locator(".opblock").count();
  assert(filteredCount > 0 && filteredCount < originalCount, "Filtering must narrow the rendered reference");
  await filter.fill("");
  await expect(reference.locator(".opblock")).toHaveCount(originalCount);

  for (const path of ["/v1/customer/me", "/v1/customer/checkout/place"]) {
    const operation = reference.locator(".opblock").filter({ has: reference.locator(".opblock-summary-path", { hasText: path }) });
    assert.equal(await operation.count(), 1, `Expected exactly one operation for ${path}`);
    await operation.locator(".opblock-summary-control").click();
    await operation.locator(".opblock-body").waitFor();
    await expectReadOnly(reference);
  }
  await expectNoOverflow(page.mainFrame(), "Desktop overview");
  await expectNoOverflow(reference, "Desktop reference");
  if (process.env.API_DOCS_SCREENSHOT_DIR) {
    await mkdir(process.env.API_DOCS_SCREENSHOT_DIR, { recursive: true });
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await reference.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: join(process.env.API_DOCS_SCREENSHOT_DIR, "desktop.png"), fullPage: true });
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoOverflow(page.mainFrame(), "Mobile overview");
  await expectNoOverflow(reference, "Mobile reference");
  if (process.env.API_DOCS_SCREENSHOT_DIR) {
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await reference.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({ path: join(process.env.API_DOCS_SCREENSHOT_DIR, "mobile.png"), fullPage: true });
  }

  // Check the standalone viewer as well as the embedding page: query overrides
  // must never cause a different spec/config to load or an external request.
  const direct = await context.newPage();
  const directResponse = await direct.goto(new URL(`/docs/api/reference/${override}`, base).href, { waitUntil: "networkidle" });
  assert.equal(directResponse.status(), 200, "The standalone reference must exist");
  await direct.locator(".swagger-ui .opblock").first().waitFor();
  assert.match(await direct.locator(".swagger-ui .info .title").innerText(), /Rocento Storefront and Customer API/);
  await expectReadOnly(direct.mainFrame());
  const csp = await direct.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  assert(csp.includes("script-src 'self'") && csp.includes("form-action 'none'"), "Static preview must retain the viewer's local-script and no-form CSP");
  assert(!csp.includes("unsafe-eval"), "The viewer must not enable dynamic code evaluation");
  const inlineScriptRan = await direct.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__apiDocsInlineProbe = true";
    document.head.append(script);
    return window.__apiDocsInlineProbe === true;
  });
  assert.equal(inlineScriptRan, false, "The viewer CSP must block inline script execution");

  assert.deepEqual(blockedRequests, [], "The viewer attempted an external or mutating request");
  assert.deepEqual(credentialRequests, [], "The public contract request must omit cookies and authorization");
  assert.deepEqual(pageErrors, [], "Documentation raised browser errors");
  assert(requests.some((request) => new URL(request.url).pathname === "/docs/api/openapi.json"), "The local public contract must be loaded");
  assert(requests.filter((request) => new URL(request.url).pathname === "/docs/api/openapi.json").every((request) => request.method === "GET"), "The viewer's contract fetch must remain GET-only");
  assert(!requests.some((request) => new URL(request.url).pathname.startsWith("/api/")), "Reading or filtering documentation must not call the commerce API");
  console.log("PASS: documentation loads, filters and expands; no auth/execution controls, API calls, external configuration, CSP bypass or mobile overflow.");
} finally {
  await browser.close();
}
