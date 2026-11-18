import { test, expect } from "@playwright/test";
test("customer draft validates, persists, and defers unconfigured checkout", async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://127.0.0.1:3100");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".error[role=alert]")).toContainText("brand");
  await page.getByLabel("Brand name").fill("Tawheed");
  await expect(page.getByLabel("Store address")).toHaveValue("tawheed");
  await page.getByLabel("Store address").fill("admin");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".error[role=alert]")).toContainText("reserved");
  await page.getByLabel("Store address").fill("tawheed");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.getByRole("button", { name: /Growth/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".theme")).toHaveCount(4);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.locator(".error[role=alert]")).toContainText("Choose");
  await page.getByRole("button", { name: /Jewelry/ }).click();
  await page.screenshot({
    path: testInfo.outputPath("onboarding-preview.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByText(/then request Rocento offline payment/i),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Paddle checkout|Cash \/ manual payment/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Sign in to reserve" }),
  ).toHaveAttribute("href", "/account");
  await page.reload();
  await expect(page.getByLabel("Brand name")).toHaveValue("Tawheed");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: /Growth/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("button", { name: /Jewelry/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: testInfo.outputPath("onboarding-mobile.png"),
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("staff surface requires a staff sign-in and hides operational data", async ({ page }) => {
  await page.route('**/api/control/me',r=>r.fulfill({status:401,json:{code:'STAFF_SESSION_REQUIRED'}}));
  await page.goto("http://127.0.0.1:3101");
  await expect(page.getByRole('heading',{name:'Sign in to Operations'})).toBeVisible();
  await expect(page.getByLabel('Email address')).toBeVisible();
  await expect(page.getByRole('navigation',{name:'Operations navigation'})).toHaveCount(0);
});

test("Rocento offline payment shows unavailable, awaiting and confirmed states", async ({ page }, testInfo) => {
  const id = "11111111-1111-4111-8111-111111111111";
  const tenant = "22222222-2222-4222-8222-222222222222";
  const payment = { id: "33333333-3333-4333-8333-333333333333", tenantId: tenant, method: "ROCENTO", amountMinor: 12345, currency: "EGP", serviceDays: 30,
    instructions: "Synthetic payment instructions for this browser fixture.", status: "AWAITING_PAYMENT", expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const draft = { id, version: 1, brand: "Fixture shop", slug: "fixture-shop", plan: "LAUNCH", theme: "grocery", payment: "ROCENTO", tenant_id: tenant, reservation_expires_at: payment.expiresAt };
  let configured = false;
  let requested = false;
  let confirmed = false;
  await page.route("**/api/control/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/me")) return route.fulfill({ json: { id: "fixture-user", email: "fixture@example.test", verified: true, orgId: "fixture-org" } });
    if (path.endsWith("/onboarding/draft")) return route.fulfill({ json: draft });
    if (route.request().method() === "PUT") return route.fulfill({ json: { ...draft, version: ++draft.version } });
    if (path.endsWith("/provisioning")) return route.fulfill({ json: { lifecycleStatus: confirmed ? "QUEUED" : "SLUG_RESERVED", status: null, step: null, reason: null } });
    if (path.endsWith("/billing/payment-requests")) return route.fulfill({ json: { items: requested ? [{ ...payment, status: confirmed ? "CONFIRMED" : "AWAITING_PAYMENT" }] : [] } });
    if (path.endsWith("/redeem")) {
      if (route.request().postDataJSON().code !== "012345") return route.fulfill({ status: 400, json: { code: "INVALID_PAYMENT_CODE" } });
      confirmed = true;
      return route.fulfill({ json: { ...payment, status: "CONFIRMED" } });
    }
    if (path.endsWith("/payment-request")) {
      if (!configured) return route.fulfill({ status: 503, json: { code: "PAYMENT_NOT_CONFIGURED" } });
      requested = true;
      return route.fulfill({ json: payment });
    }
    return route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
  });
  await page.goto("http://127.0.0.1:3100");
  const panel = page.getByRole("region", { name: "Rocento payment" });
  await expect(panel.getByRole("heading", { name: "Payment method: Rocento" })).toBeVisible();
  await panel.getByRole("button", { name: "Request Rocento payment" }).click();
  await expect(panel.getByRole("alert")).toContainText("instructions are not ready");
  configured = true;
  await panel.getByRole("button", { name: "Request Rocento payment" }).click();
  await expect(panel.getByRole("status")).toContainText("enter the code");
  await expect(panel).toContainText("30 service days");
  await expect(panel).toContainText(payment.instructions);
  await page.screenshot({ path: testInfo.outputPath("rocento-payment-desktop.png"), fullPage: true });
  await panel.getByLabel("Six-digit payment code").fill("999999");
  await panel.getByRole("button", { name: "Confirm payment code" }).click();
  await expect(panel.getByRole("alert")).toContainText("incorrect");
  await panel.getByLabel("Six-digit payment code").fill("012345");
  await panel.getByRole("button", { name: "Confirm payment code" }).click();
  await expect(panel.getByRole("status")).toContainText("Payment confirmed. Store setup is pending.");
  await page.reload();
  await expect(panel.getByRole("status")).toContainText("Payment confirmed");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("rocento-payment-mobile.png"), fullPage: true });
});

test("paid setup reports blockers and only exposes store links after activation", async ({ page }, testInfo) => {
  const draftId = "11111111-1111-4111-8111-111111111111";
  const tenantId = "22222222-2222-4222-8222-222222222222";
  let active = false;
  let checkpoint = "RELEASE";
  await page.route("**/api/control/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/me")) return route.fulfill({ json: { id: "customer", email: "fixture@example.test", verified: true } });
    if (path.endsWith("/onboarding/draft")) return route.fulfill({ json: { id: draftId, version: 3, brand: "Provisioning fixture", slug: "provisioning-fixture", plan: "LAUNCH", theme: "grocery", payment: "ROCENTO", tenant_id: tenantId } });
    if (path.endsWith("/billing/payment-requests")) return route.fulfill({ json: { items: [{ id: "33333333-3333-4333-8333-333333333333", tenantId, method: "ROCENTO", amountMinor: 100, currency: "EGP", serviceDays: 30, instructions: "Test only", status: "CONFIRMED", expiresAt: "2030-01-01T00:00:00Z" }] } });
    if (path.endsWith("/provisioning")) return route.fulfill({ json: { lifecycleStatus: active ? "ACTIVE" : checkpoint === "RELEASE" ? "QUEUED" : "DEPLOYING", status: active ? "SUCCEEDED" : checkpoint === "RELEASE" ? "BLOCKED" : "RUNNING", step: active ? "DONE" : checkpoint, reason: active ? null : "APPROVED_RELEASE_REQUIRED", storefrontUrl: active ? "https://provisioning-fixture.rocento.com" : null, adminUrl: active ? "https://provisioning-fixture-admin.rocento.com" : null, serviceStartsAt: active ? "2026-11-12T00:00:00Z" : null, serviceEndsAt: active ? "2026-12-12T00:00:00Z" : null } });
    return route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
  });
  await page.goto("http://127.0.0.1:3100");
  await expect(page.getByRole("navigation", { name: "Setup progress" })).toBeVisible();
  const panel = page.getByRole("region", { name: "Store setup status" });
  await expect(panel.getByRole("status")).toContainText("awaiting approval");
  await expect(panel.getByRole("link")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("provisioning-blocked.png"), fullPage: true });
  for (checkpoint of ["DATABASE", "MIGRATE", "SERVICES", "BOOTSTRAP", "INGRESS"]) {
    const refreshed = page.waitForResponse(response => response.url().endsWith("/provisioning"));
    await panel.getByRole("button", { name: "Refresh setup status" }).click();
    expect((await (await refreshed).json()).step).toBe(checkpoint);
    await expect(panel.locator('[aria-current="step"]')).toContainText("Deploy");
    await expect(panel.getByRole("link")).toHaveCount(0);
  }
  active = true;
  await panel.getByRole("button", { name: "Refresh setup status" }).click();
  await expect(page.getByRole("heading", { name: "Welcome back to Provisioning fixture" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open storefront" })).toHaveAttribute("href", "https://provisioning-fixture.rocento.com");
  await expect(page.getByRole("region", { name: "Rocento payment" })).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Setup progress" })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("provisioning-active-mobile.png"), fullPage: true });
});

test("staff verifies funds and receives a code for manual delivery", async ({ page }) => {
  const payment = { id: "33333333-3333-4333-8333-333333333333", tenantId: "22222222-2222-4222-8222-222222222222", slug: "code-shop", email: "client@example.test", amountMinor: 34800, currency: "USD", serviceDays: 360, serviceMonths: 12, status: "AWAITING_PAYMENT", managementState: "ENABLED" };
  await page.route("**/api/control/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/me")) return route.fulfill({ json: { id: "staff", email: "owner@example.test", role: "OWNER" } });
    if (path.endsWith("/dashboard")) return route.fulfill({ json: { counts: { clients: 1, active: 0, awaitingPayment: 1, setupAttention: 0 }, payments: [payment], jobs: [], activity: [] } });
    if (path.endsWith("/clients")) return route.fulfill({ json: { items: [], total: 0, page: 0 } });
    if (path.endsWith("/confirm")) {
      expect(route.request().postDataJSON()).toEqual({ receiptReference: "bank-verified-123", amountMinor: 34800, currency: "USD", serviceDays: 360 });
      return route.fulfill({ json: { code: "012345", paymentRequestId: payment.id } });
    }
    return route.fulfill({ status: 404, json: { code: "NOT_FOUND" } });
  });
  await page.goto("http://127.0.0.1:3101");
  await page.getByRole("button", { name: "Payments", exact: false }).first().click();
  await page.getByRole("button", { name: "Verify & generate code" }).click();
  await expect(page.getByRole("dialog")).toContainText("12 calendar months");
  await page.getByLabel("Receipt reference").fill("bank-verified-123");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Generate six-digit code" }).click();
  await expect(page.getByText(/Send code 012345 manually to client@example.test/)).toBeVisible();
  await expect(page.getByText(/Setup waits for the client to redeem it/)).toBeVisible();
});
