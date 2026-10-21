import { describe, expect, it } from "vitest";
import type { StockPoolInput } from "@commerce/api-client";
import {
  deductionOrder,
  nextSourcePriority,
  setSourceAssignment,
  setSourcePriority,
} from "./msi-logic";

function stock(sources: StockPoolInput["sources"] = []): StockPoolInput {
  return {
    code: "main",
    name: "Main Stock",
    is_default: false, is_global: false,
    sources,
  };
}

describe("MSI stock source relationship behavior", () => {
  it("assigns new sources with Adobe-style priority spacing", () => {
    const updated = setSourceAssignment(stock([{ source_id: "a", priority: 0 }]), "b", true);

    expect(updated.sources).toEqual([
      { source_id: "a", priority: 0 },
      { source_id: "b", priority: 10 },
    ]);
    expect(nextSourcePriority(updated)).toBe(20);
  });

  it("does not duplicate an already assigned source", () => {
    const original = stock([{ source_id: "a", priority: 0 }]);

    expect(setSourceAssignment(original, "a", true)).toBe(original);
  });

  it("removes a source assignment without touching others", () => {
    expect(
      setSourceAssignment(
        stock([
          { source_id: "a", priority: 0 },
          { source_id: "b", priority: 10 },
        ]),
        "a",
        false,
      ).sources,
    ).toEqual([{ source_id: "b", priority: 10 }]);
  });

  it("updates priority for one source only", () => {
    expect(
      setSourcePriority(
        stock([
          { source_id: "a", priority: 0 },
          { source_id: "b", priority: 10 },
        ]),
        "b",
        5,
      ).sources,
    ).toEqual([
      { source_id: "a", priority: 0 },
      { source_id: "b", priority: 5 },
    ]);
  });

  it("returns deduction order without mutating the stock", () => {
    const original = stock([
      { source_id: "slow", priority: 20 },
      { source_id: "fast", priority: 0 },
    ]);

    expect(deductionOrder(original).map((source) => source.source_id)).toEqual([
      "fast",
      "slow",
    ]);
    expect(original.sources.map((source) => source.source_id)).toEqual([
      "slow",
      "fast",
    ]);
  });
});
