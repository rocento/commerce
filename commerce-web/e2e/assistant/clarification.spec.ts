import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const theme = JSON.parse(readFileSync(new URL('../../packages/api-client/src/theme-contract.json', import.meta.url), 'utf8')).default;
const id = '00000000-0000-4000-8000-000000000006';
const context = { original_message: 'pls add two product to cart', question: 'Which product or items do you mean?' };

test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', route => route.fulfill({ json: [] }));
  await page.route('**/api/v1/theme/*', route => route.fulfill({ json: { configuration: theme, cities: [] } }));
  await page.route('**/api/v1/customer/auth/refresh', route => route.fulfill({ status: 401, json: {} }));
  await page.route('**/api/v1/delivery-area*', route => route.fulfill({ json: { configured: false, deliverable: true } }));
  await page.route('**/api/v1/cart', route => route.fulfill({ json: { id, items: [], subtotal: '0.00', currency: 'USD' } }));
});

for (const via of ['inline', 'composer']) {
  test(`clarification routes input correctly via ${via}`, async ({ page }, info) => {
    const requests: Record<string, unknown>[] = [];
    await page.route('**/api/v1/assistant/chat', route => {
      const input = route.request().postDataJSON(); requests.push(input);
      const events = requests.length === 1 ? [{ type: 'message.delta', text: context.question, clarification: context }, { type: 'done' }] : [{ type: 'message.delta', text: 'Here are matching fish products. Choose a product and add 2 using its cart controls.' }, { type: 'done' }];
      return route.fulfill({ contentType: 'text/event-stream', body: events.map((event, sequence) => `data: ${JSON.stringify({ version: '1', request_id: input.request_id, sequence, ...event })}\n\n`).join('') });
    });
    await page.goto('/assistant');
    const composer = page.getByPlaceholder('Ask about an order, or tell us what you need…');
    await composer.fill(context.original_message);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const reply = page.getByRole('form', { name: 'Reply to clarification' });
    await expect(reply).toBeVisible();
    await expect(reply.getByText(`Your request: ${context.original_message}`)).toBeVisible();
    await expect(reply.getByRole('button', { name: 'Send reply', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (via === 'inline') {
      await reply.getByRole('textbox').fill('fish');
      await page.screenshot({ path: info.outputPath('clarification-reply.png') });
      await reply.getByRole('button', { name: 'Send reply', exact: true }).click();
    } else {
      await composer.fill('fish');
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
    }
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].message).toBe('fish');
    expect(requests[1].clarification).toEqual(via === 'inline' ? context : undefined);
    expect(requests[1].conversation_id).toBe(requests[0].conversation_id);
    await expect(reply).toHaveCount(0);
    await expect(page.getByText(/Here are matching fish products/)).toBeVisible();
  });
}

test('ordinary question-mark prose does not create a clarification form', async ({ page }) => {
  await page.route('**/api/v1/assistant/chat', route => {
    const input = route.request().postDataJSON();
    return route.fulfill({ contentType: 'text/event-stream', body: [{ type: 'message.delta', text: 'Would you like to browse the catalog?' }, { type: 'done' }].map((event, sequence) => `data: ${JSON.stringify({ version: '1', request_id: input.request_id, sequence, ...event })}\n\n`).join('') });
  });
  await page.goto('/assistant');
  await page.getByPlaceholder('Ask about an order, or tell us what you need…').fill('hello');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Would you like to browse the catalog?')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Reply to clarification' })).toHaveCount(0);
});

for (const replyMethod of ['choice', 'skip', 'budget']) {
  test(`shopping clarification offers observed choices and preserves context via ${replyMethod}`, async ({ page }, info) => {
    const context = { original_message: 'I need good phone', question: 'What is your budget?', revision: id, kind: 'shopping', choices: ['Up to 500 USD'], optional: true };
    const requests: Record<string, unknown>[] = [];
    await page.route('**/api/v1/assistant/chat', route => {
      const input = route.request().postDataJSON(); requests.push(input);
      const events = requests.length === 1 ? [{ type: 'message.delta', text: context.question, clarification: context }, { type: 'done' }] : [{ type: 'message.delta', text: 'Here are phones matching your refined request.' }, { type: 'done' }];
      return route.fulfill({ contentType: 'text/event-stream', body: events.map((event, sequence) => `data: ${JSON.stringify({ version: '1', request_id: input.request_id, sequence, response_source: 'R', ...event })}\n\n`).join('') });
    });
    await page.goto('/assistant');
    await page.getByPlaceholder('Ask about an order, or tell us what you need…').fill(context.original_message);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const form = page.getByRole('form', { name: 'Reply to clarification' });
    await expect(form.getByRole('button', { name: 'Up to 500 USD', exact: true })).toBeVisible();
    await expect(form.getByRole('button', { name: 'Show options', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (replyMethod === 'budget') await form.getByRole('textbox').fill('under $500');
    await page.screenshot({ path: info.outputPath(`shopping-${replyMethod}.png`), fullPage: true });
    if (replyMethod === 'budget') await form.getByRole('button', { name: 'Send reply', exact: true }).click();
    else await form.getByRole('button', { name: replyMethod === 'skip' ? 'Show options' : 'Up to 500 USD', exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].message).toBe(replyMethod === 'budget' ? 'under $500' : replyMethod === 'skip' ? 'Show options' : 'Up to 500 USD');
    expect(requests[1].clarification).toEqual(context);
    expect(requests[1].conversation_id).toBe(requests[0].conversation_id);
    expect(requests[1]).not.toHaveProperty('frame');
    await expect(form).toHaveCount(0);
    await expect(page.getByText('Here are phones matching your refined request.')).toBeVisible();
  });
}
