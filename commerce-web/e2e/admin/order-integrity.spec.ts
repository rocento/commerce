import { test, expect } from './fixtures';

// Read-only real-service regression: a working grid must never hide broken
// detail records. This catches incomplete imported/seeded orders as well as
// normal checkout regressions. Uses the existing admin global login fixture.
test('every listed order has readable detail and a matching payment obligation', async ({ request }) => {
  test.setTimeout(180_000);
  const seen = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const params: Record<string, string> = { limit: '200', sort: 'id', descending: 'false' };
    if (cursor) params.cursor = cursor;
    const response = await request.get('/api/v1/admin/grids/orders', { params });
    expect(response.status(), 'Order grid must load').toBe(200);
    const page = await response.json() as { items: { id: string; number: number }[]; next_cursor: string | null };
    expect(Array.isArray(page.items)).toBe(true);
    for (const order of page.items) {
      expect(seen.has(order.id), `Order #${order.number} appeared on multiple pages`).toBe(false);
      seen.add(order.id);
      const detail = await request.get(`/api/v1/admin/orders/${encodeURIComponent(order.id)}`);
      expect(detail.status(), `Order #${order.number} detail must load`).toBe(200);
      const body = await detail.json();
      expect(body.order.id).toBe(order.id);
      expect(body.payment.order_id).toBe(order.id);
      expect(body.payment.currency).toBe(body.order.currency);
      expect(Number(body.payment.amount_due)).toBe(Number(body.order.total));
      expect(Array.isArray(body.items)).toBe(true);
    }
    cursor = page.next_cursor;
    if (cursor) {
      expect(cursors.has(cursor), 'Order pagination cursor must advance').toBe(false);
      cursors.add(cursor);
    }
  } while (cursor);
  expect(seen.size, 'Seed orders before the customer-demo acceptance run').toBeGreaterThan(0);
});
