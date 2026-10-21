import { expect, it, vi } from "vitest";
import { entityInput } from "./entity-id";
import { capacityApi } from "./capacity";
import { marketsApi } from "./markets";
import { assistantSchemas } from "./assistant-schemas";
import { validates } from "./assistant-validation";
vi.mock("./telemetry", () => ({ traceFetch: (input: string, init?: RequestInit) => fetch(input, init) }));

it("omits the numeric ID while retaining UUID identity and relationship values", () => {
  const row = { id: "uuid-identity", entity_id: 123, parent_id: "uuid-parent", attributes: { entity_id: 456 } };
  expect(entityInput(row)).toEqual({ id: "uuid-identity", parent_id: "uuid-parent", attributes: { entity_id: 456 } });
  expect(row.entity_id).toBe(123);
  expect(entityInput({ entity_id: "uuid-target", locale: "en" })).toEqual({ entity_id: "uuid-target", locale: "en" });
});

it("accepts numeric IDs in assistant support responses while replaying older records", () => {
  const ticket = { id: "00000000-0000-0000-0000-000000000001", number: 1, subject: "Delivery help", category: "order_issue", status: "open", priority: "normal", order_id: null, created_at: "2026-10-03T12:00:00Z" };
  expect(validates(ticket, assistantSchemas.AssistantTicket)).toBe(true);
  expect(validates({ ...ticket, entity_id: 123 }, assistantSchemas.AssistantTicket)).toBe(true);
  for (const entity_id of ["123", null, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(validates({ ...ticket, entity_id }, assistantSchemas.AssistantTicket)).toBe(false);
});

it("does not round-trip read-only IDs when saving loaded schedules, rules, or markets", async () => {
  const bodies: unknown[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  }));
  try {
    await capacityApi.saveSchedule({ id: "schedule", entity_id: 10, source_id: "source", area_id: null, method: "delivery", enabled: true, timezone: "UTC", config: { windows: [], duration_minutes: 60, spacing_minutes: 0, lead_minutes: 0, cutoff: null, min_days: 0, max_days: 7, ttl_minutes: 10, release_before: "never", exceptions: [] } }, "Update schedule");
    await capacityApi.saveRule({ id: "rule", entity_id: 20, overrides_rule_id: null, source_id: null, area_id: null, method: null, timezone: "UTC", local_start: null, period: "day", limits: { orders: 10 }, overflow_percent: 0, starts_on: null, ends_on: null, enabled: true }, "Update rule", false);
    await marketsApi.save({ id: "market", entity_id: 30, name: "Egypt", country: "EG", currency: "EGP", locales: ["en"], default_locale: "en", expected_revision: 1 } as Parameters<typeof marketsApi.save>[0]);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({ schedule: { id: "schedule", source_id: "source" } });
    expect(bodies[1]).toMatchObject({ rule: { id: "rule" } });
    expect(bodies[2]).toMatchObject({ id: "market" });
    for (const body of bodies) expect(JSON.stringify(body)).not.toContain('"entity_id"');
  } finally {
    vi.unstubAllGlobals();
  }
});
