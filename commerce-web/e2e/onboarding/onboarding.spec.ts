import { test, expect } from "@playwright/test";
test("customer draft validates, persists, and defers unconfigured checkout", async ({
  page,
}) => {
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
    path: "../commerce-docs/onboarding/assets/onboarding-preview.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(
    page.getByText(/checkout and store launch are not available in this phase/i),
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
    path: "../commerce-docs/onboarding/assets/onboarding-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});
test("staff surface exposes a locked boundary", async ({ page }) => {
  await page.goto("http://127.0.0.1:3101");
  await expect(
    page.getByRole("button", { name: "Staff sign-in unavailable" }),
  ).toBeDisabled();
  await expect(
    page.getByText("Staff operations are outside this project phase"),
  ).toBeVisible();
});
