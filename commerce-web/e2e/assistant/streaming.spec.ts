import { test, expect, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";

const theme = JSON.parse(readFileSync(new URL("../../packages/api-client/src/theme-contract.json", import.meta.url), "utf8")).default;

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: [] }));
  await page.route("**/api/v1/theme/*", route => route.fulfill({ json: { configuration: theme, cities: [] } }));
  await page.route("**/api/v1/customer/auth/refresh", route => route.fulfill({ status: 401, json: { error: "Unauthorized" } }));
  await page.route("**/api/v1/languages", route => route.fulfill({ json: { source_locale: "en", languages: [] } }));
  await page.route("**/api/v1/cart", route => route.fulfill({ json: { items: [], subtotal: "0.00", currency: "USD" } }));
  await page.route("**/api/v1/assistant/memory*", route => route.fulfill({ json: { enabled: false } }));
});

async function answer(route: Route, text: string) {
  const input = route.request().postDataJSON();
  const events = [{ type: "message.delta", text }, { type: "done" }];
  await route.fulfill({ contentType: "text/event-stream", body: events.map((event, sequence) => `data: ${JSON.stringify({ version: "1", request_id: input.request_id, sequence, ...event })}\n\n`).join("") });
}

test("stopping and retrying a response keeps one customer question", async ({ page }) => {
  const requests: { request_id: string; message: string }[] = [];
  let pending: Route | undefined;
  await page.route("**/api/v1/assistant/chat", async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) { pending = route; return; }
    await answer(route, "Here are today's suggestions.");
  });
  await page.goto("/assistant");
  const composer = page.getByRole("textbox", { name: "Your message" });
  await composer.fill("Find something for dinner");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.getByRole("button", { name: "Stop response", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Any partial answer is kept above" })).toBeVisible();
  await expect(composer).toBeFocused();
  await page.getByRole("button", { name: "Retry response", exact: true }).click();
  await expect(page.getByRole("article", { name: "Assistant response", exact: true })).toContainText("Here are today's suggestions.");
  await expect(page.getByRole("article", { name: "Your message", exact: true })).toHaveCount(1);
  expect(requests).toHaveLength(2);
  expect(requests[1].request_id).not.toBe(requests[0].request_id);
  expect(requests[1].message).toBe(requests[0].message);
  await answer(pending!, "An old answer that must be ignored.").catch(() => {});
  await expect(page.locator(".assistant-messages")).not.toContainText("An old answer");
});

test("an unavailable response can retry without duplicating the question", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/v1/assistant/chat", route => ++calls === 1
    ? route.fulfill({ status: 503, json: { error: "Unavailable" } })
    : answer(route, "The catalog is available again."));
  await page.goto("/assistant");
  await page.getByRole("textbox", { name: "Your message" }).fill("Recommend a gift");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("HTTP 503");
  await page.getByRole("button", { name: "Retry response", exact: true }).click();
  await expect(page.getByRole("article", { name: "Assistant response", exact: true })).toContainText("The catalog is available again.");
  await expect(page.getByRole("article", { name: "Your message", exact: true })).toHaveCount(1);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(calls).toBe(2);
});

test("stop also cancels a pending memory lookup before chat starts", async ({ page }) => {
  let holdMemory = false;
  let memoryCalls = 0;
  let chatCalls = 0;
  const pending: Route[] = [];
  await page.route("**/api/v1/assistant/memory*", route => {
    memoryCalls++;
    if (holdMemory) { pending.push(route); return; }
    return route.fulfill({ json: { enabled: false } });
  });
  await page.route("**/api/v1/assistant/chat", route => { chatCalls++; return answer(route, "A fresh response."); });
  await page.goto("/assistant");
  await expect.poll(() => memoryCalls).toBeGreaterThan(0);
  holdMemory = true;
  await page.getByRole("textbox", { name: "Your message" }).fill("Find breakfast items");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => pending.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Stop response", exact: true }).click();
  await expect(page.getByRole("button", { name: "Retry response", exact: true })).toBeVisible();
  expect(chatCalls).toBe(0);
  holdMemory = false;
  for (const route of pending) await route.fulfill({ json: { enabled: false } }).catch(() => {});
  await page.getByRole("button", { name: "Retry response", exact: true }).click();
  await expect(page.getByRole("article", { name: "Assistant response", exact: true })).toContainText("A fresh response.");
  expect(chatCalls).toBe(1);
});

test("leaving a pending response cannot populate a new conversation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let pending: Route | undefined;
  await page.route("**/api/v1/assistant/chat", route => { pending = route; });
  await page.goto("/assistant");
  await page.getByRole("textbox", { name: "Your message" }).fill("Find household essentials");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect.poll(() => !!pending).toBe(true);
  await page.getByRole("link", { name: "Back to website", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await answer(pending!, "A response from the old conversation.").catch(() => {});
  await page.goto("/assistant");
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toBeVisible();
  await expect(page.locator(".assistant-message")).toHaveCount(0);
  expect(errors).toEqual([]);
});
