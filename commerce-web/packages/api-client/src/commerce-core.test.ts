import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validatesCore } from "./commerce-core-validation";

const load = (name: string) => JSON.parse(readFileSync(new URL(`../../../../commerce-api/rocento-api/crates/commerce-core-contracts/contract/v1/${name}`, import.meta.url), "utf8"));
const schema = load("schema.json");
const fixtures: { id: string; contract: string; valid: boolean; value: unknown }[] = load("fixtures.json");
describe("canonical commerce core compatibility", () => {
  it.each(fixtures)("$id", fixture => {
    expect(validatesCore(fixture.value, fixture.contract, schema)).toBe(fixture.valid);
  });
  it("rejects unknown contracts", () => expect(validatesCore({}, "Unknown", schema)).toBe(false));
});

const meaningLoad = (name: string) => JSON.parse(readFileSync(new URL(`../../../../commerce-assistant-platform/contracts/commerce-meaning/v1/${name}`, import.meta.url), "utf8"));
const meaningSchema = meaningLoad("schema.json");
const meaningFixtures: { id: string; contract: string; valid: boolean; value: unknown }[] = meaningLoad("fixtures.json");
describe("additive commerce meaning wire contracts", () => {
  it.each(meaningFixtures)("$id", fixture => {
    expect(validatesCore(fixture.value, fixture.contract, meaningSchema)).toBe(fixture.valid);
  });
});

const planningLoad = (name: string) => JSON.parse(readFileSync(new URL(`../../../../commerce-assistant-platform/contracts/commerce-planning/v1/${name}`, import.meta.url), "utf8"));
const planningSchema = planningLoad("schema.json");
const planningFixtures: { id: string; contract: string; valid: boolean; value: unknown }[] = planningLoad("fixtures.json");
describe("executable planning wire contracts", () => {
  it.each(planningFixtures)("$id", fixture => {
    expect(validatesCore(fixture.value, fixture.contract, planningSchema)).toBe(fixture.valid);
  });
});
